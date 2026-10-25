import { describe, expect, it } from 'vitest'
import {
  compressImageToCap, prepareUploadFile,
  type CompressDeps, type CompressSurface,
} from '../src/client/compress.ts'

const MB = 1024 * 1024
const CAP = 5 * MB

/** A Blob of exactly n bytes carrying the given MIME type. */
const bytes = (n: number, type = 'image/webp'): Blob => new Blob([new Uint8Array(n)], { type })

/** One encode request, recorded for assertions. */
interface EncodeCall {
  type: string
  quality: number
  width: number
  height: number
}

interface FakeOptions {
  width: number
  height: number
  /** Answer one encode request; the default (null) models an encode failure. */
  encode?: (call: EncodeCall) => Blob | null
}

/** Injectable CompressDeps fake recording canvases, clears, backdrops, and encodes. */
function fakeDeps(options: FakeOptions) {
  const encodes: EncodeCall[] = []
  const canvases: { width: number; height: number; clears: number; backdrops: string[]; draws: number }[] = []
  let decodeFail = false
  const deps: CompressDeps = {
    decode: async () => {
      if (decodeFail) throw new Error('undecodable')
      return { width: options.width, height: options.height, image: { } as CanvasImageSource }
    },
    createCanvas: (width, height) => {
      const canvas = { width, height, clears: 0, backdrops: [] as string[], draws: 0 }
      canvases.push(canvas)
      return {
        clear: () => { canvas.clears += 1 },
        fillBackdrop: color => { canvas.backdrops.push(color) },
        draw: () => { canvas.draws += 1 },
        encode: (type, quality) => {
          encodes.push({ type, quality, width, height })
          return Promise.resolve(options.encode?.({ type, quality, width, height }) ?? null)
        },
      } satisfies CompressSurface
    },
  }
  return { deps, encodes, canvases, setDecodeFail: () => { decodeFail = true } }
}

describe('compressImageToCap', () => {
  it('returns the first encode that fits the cap', async () => {
    const fake = fakeDeps({ width: 4000, height: 3000, encode: () => bytes(MB) })
    const blob = await compressImageToCap(bytes(6 * MB), CAP, fake.deps)
    expect(blob?.type).toBe('image/webp')
    expect(fake.encodes).toEqual([{ type: 'image/webp', quality: 0.85, width: 4000, height: 3000 }])
  })

  it('walks the quality ladder before touching dimensions', async () => {
    const fake = fakeDeps({
      width: 4000,
      height: 3000,
      encode: call => bytes(call.quality === 0.85 ? 6 * MB : MB),
    })
    const blob = await compressImageToCap(bytes(6 * MB), CAP, fake.deps)
    expect(blob?.size).toBe(MB)
    expect(fake.encodes.map(call => call.quality)).toEqual([0.85, 0.7])
    // Every attempt must start from a cleared surface: drawImage composites
    // source-over, so without clear() semi-transparent pixels would accumulate.
    expect(fake.canvases[0]?.clears).toBe(2)
    expect(fake.canvases).toHaveLength(1)
  })

  it('scales the dimensions down when quality alone cannot fit', async () => {
    const fake = fakeDeps({
      width: 4000,
      height: 3000,
      encode: call => bytes(call.width < 4000 ? MB : 6 * MB),
    })
    const blob = await compressImageToCap(bytes(6 * MB), CAP, fake.deps)
    expect(blob?.size).toBe(MB)
    expect(fake.canvases.map(canvas => canvas.width)).toEqual([4000, 3200])
    expect(fake.encodes.at(-1)).toMatchObject({ quality: 0.85, width: 3200, height: 2400 })
  })

  it('gives up (null) after the scale rounds are exhausted', async () => {
    const fake = fakeDeps({ width: 4000, height: 3000, encode: () => bytes(6 * MB) })
    const blob = await compressImageToCap(bytes(6 * MB), CAP, fake.deps)
    expect(blob).toBeNull()
    // The 12MP source stops at the 1MP floor before MAX_SCALE_ROUNDS is hit.
    expect(fake.canvases.length).toBeLessThan(7)
    expect(fake.encodes.every(call => call.type === 'image/webp')).toBe(true)
  })

  it('falls back to JPEG over a white backdrop when WebP encoding is unavailable', async () => {
    const fake = fakeDeps({
      width: 2000,
      height: 1500,
      // Firefox answers toBlob('image/webp') with its PNG fallback type.
      encode: call => call.type === 'image/webp' ? bytes(MB, 'image/png') : bytes(MB, 'image/jpeg'),
    })
    const blob = await compressImageToCap(bytes(6 * MB, 'image/png'), CAP, fake.deps)
    expect(blob?.type).toBe('image/jpeg')
    expect(fake.encodes.map(call => call.type)).toEqual(['image/webp', 'image/jpeg'])
    expect(fake.canvases[0]?.backdrops).toEqual(['#ffffff'])
    // The WebP attempt preserves alpha: no backdrop painted for it.
    expect(fake.canvases[0]?.backdrops).toHaveLength(1)
  })

  it('resolves null when the file is undecodable', async () => {
    const fake = fakeDeps({ width: 100, height: 100 })
    fake.setDecodeFail()
    expect(await compressImageToCap(bytes(MB), CAP, fake.deps)).toBeNull()
    expect(fake.encodes).toEqual([])
  })
})

describe('prepareUploadFile', () => {
  it('passes files within the cap through untouched', async () => {
    const file = new File([bytes(1024, 'image/png')], 'small.png', { type: 'image/png' })
    const { deps, encodes } = fakeDeps({ width: 10, height: 10 })
    const prepared = await prepareUploadFile(file, deps)
    expect(prepared).toBe(file)
    expect(encodes).toEqual([])
  })

  it('compresses oversized files and swaps the extension to the encoded type', async () => {
    const file = new File([bytes(6 * MB, 'image/jpeg')], 'photo.jpg', { type: 'image/jpeg' })
    const fake = fakeDeps({ width: 4000, height: 3000, encode: () => bytes(MB) })
    const prepared = await prepareUploadFile(file, fake.deps)
    expect(prepared?.name).toBe('photo.webp')
    expect(prepared?.type).toBe('image/webp')
    expect(prepared?.size).toBe(MB)
  })

  it('appends an extension when the original name has none', async () => {
    const file = new File([bytes(6 * MB, 'image/jpeg')], 'wallpaper', { type: 'image/jpeg' })
    const fake = fakeDeps({ width: 1000, height: 1000, encode: () => bytes(MB, 'image/jpeg') })
    expect((await prepareUploadFile(file, fake.deps))?.name).toBe('wallpaper.jpg')
  })

  it('resolves null when compression cannot reach the cap', async () => {
    const file = new File([bytes(6 * MB, 'image/png')], 'huge.png', { type: 'image/png' })
    const fake = fakeDeps({ width: 4000, height: 3000, encode: () => bytes(6 * MB) })
    expect(await prepareUploadFile(file, fake.deps)).toBeNull()
  })
})
