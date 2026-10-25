/**
 * Client-side compression for oversized wallpaper uploads. Files within the
 * cap pass through untouched (no recompression, no quality loss); oversized
 * ones are decoded (EXIF-oriented, animated sources take their first frame —
 * the chosen static-image degradation), redrawn onto a canvas, and
 * re-encoded through a quality ladder with a dimension-scale fallback until
 * the bytes fit. Zero dependencies: everything comes from the browser canvas
 * API, so `lib/client.js` only grows by about a kilobyte.
 *
 * Codec strategy: WebP first — best ratio, preserves alpha, and the dsh
 * client runs on Chromium, which always encodes it. When `toBlob('image/webp')`
 * answers with a different type (Firefox falls back to PNG), the ladder
 * reruns as JPEG over an opaque white backdrop (JPEG has no alpha channel;
 * transparent areas would otherwise turn black). The Host re-derives the real
 * extension from the magic numbers and enforces the same cap as a hard
 * backstop, so a compressed upload needs no special handling on the wire.
 *
 * The touched browser surface is injected ({@link CompressDeps}) so the test
 * suite can drive the whole ladder without a canvas implementation (jsdom
 * has none).
 */
import { UPLOAD_MAX_BYTES } from '../skin-settings.ts'

/** Encoded-quality ladder tried per scale round (WebP/JPEG quality knob). */
const QUALITY_LADDER = [0.85, 0.7, 0.55] as const

/** Dimension scale applied between rounds when quality alone cannot fit. */
const SCALE_STEP = 0.8

/** Rounds beyond the first (scale 1) before giving up. */
const MAX_SCALE_ROUNDS = 6

/** Stop scaling once the next round would drop under this pixel area. */
const MIN_PIXELS = 1_000_000

/** Backdrop painted under the image when encoding JPEG (no alpha channel). */
const JPEG_BACKDROP = '#ffffff'

/** Encoded formats this module can produce, mapped to filename extensions. */
const ENCODED_EXTENSIONS: Partial<Record<string, string>> = {
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/png': '.png',
}

/** One decoded image plus its pixel dimensions (the createImageBitmap shape). */
export interface DecodedImage {
  width: number
  height: number
  image: CanvasImageSource
  /** Release the decoded pixels; optional so lightweight fakes work too. */
  close?(): void
}

/**
 * The drawing surface the compressor renders onto, as intention-revealing
 * operations. The browser adapter wraps one HTMLCanvasElement; tests fake it.
 */
export interface CompressSurface {
  /** Reset the surface to fully transparent (attempts must not composite over each other). */
  clear(): void
  /** Paint an opaque backdrop color (JPEG has no alpha channel). */
  fillBackdrop(color: string): void
  /** Draw the decoded image scaled to width×height with high-quality smoothing. */
  draw(image: CanvasImageSource, width: number, height: number): void
  /** Encode the current pixels; resolves null on encode failure. */
  encode(type: string, quality: number): Promise<Blob | null>
}

/** The browser primitives the compressor needs; injectable for tests. */
export interface CompressDeps {
  /** Decode one blob; EXIF orientation applied, animated sources yield frame 1. */
  decode(blob: Blob): Promise<DecodedImage>
  /** Create an in-memory canvas of the given pixel size. */
  createCanvas(width: number, height: number): CompressSurface
}

/** Browser implementation: createImageBitmap for decode, a canvas element for drawing. */
export function defaultCompressDeps(): CompressDeps {
  return {
    async decode(blob: Blob): Promise<DecodedImage> {
      // `from-image` honors EXIF orientation; animated sources decode their
      // first frame, which is the static-image degradation for oversized ones.
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      return { width: bitmap.width, height: bitmap.height, image: bitmap, close: () => bitmap.close() }
    },
    createCanvas(width: number, height: number): CompressSurface {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('2D canvas context unavailable')
      return {
        clear: () => { ctx.clearRect(0, 0, width, height) },
        fillBackdrop: color => {
          ctx.fillStyle = color
          ctx.fillRect(0, 0, width, height)
        },
        draw: (image, drawWidth, drawHeight) => {
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(image, 0, 0, drawWidth, drawHeight)
        },
        encode: (type, quality) => new Promise(resolve => { canvas.toBlob(resolve, type, quality) }),
      }
    },
  }
}

/**
 * Re-encode one (already oversized) image until it fits `maxBytes`. Returns
 * null when the file is undecodable or even the smallest output of the
 * ladder misses the cap — the caller shows the existing "too large" error.
 */
export async function compressImageToCap(
  file: Blob,
  maxBytes: number,
  deps: CompressDeps = defaultCompressDeps(),
): Promise<Blob | null> {
  let decoded: DecodedImage
  try {
    decoded = await deps.decode(file)
  } catch {
    return null
  }
  try {
    let webpUsable = true
    let scale = 1
    for (let round = 0; ; round += 1) {
      const width = Math.max(1, Math.round(decoded.width * scale))
      const height = Math.max(1, Math.round(decoded.height * scale))
      const surface = deps.createCanvas(width, height)
      /** One quality ladder at the current scale; null when nothing fits. */
      const attempt = async (codec: 'image/webp' | 'image/jpeg'): Promise<Blob | null> => {
        for (const quality of QUALITY_LADDER) {
          surface.clear()
          if (codec === 'image/jpeg') surface.fillBackdrop(JPEG_BACKDROP)
          surface.draw(decoded.image, width, height)
          const blob = await surface.encode(codec, quality)
          if (blob === null) return null
          if (codec === 'image/webp' && blob.type !== 'image/webp') return blob
          if (blob.size <= maxBytes) return blob
        }
        return null
      }
      let result = webpUsable ? await attempt('image/webp') : null
      if (result !== null && result.type !== 'image/webp') {
        // The browser answered toBlob('image/webp') with a fallback type:
        // rerun the ladder as JPEG (flattens alpha onto the backdrop).
        webpUsable = false
        result = await attempt('image/jpeg')
      }
      if (result !== null && result.size <= maxBytes) return result
      const nextScale = scale * SCALE_STEP
      const nextArea = decoded.width * nextScale * (decoded.height * nextScale)
      if (round >= MAX_SCALE_ROUNDS || nextArea < MIN_PIXELS) return null
      scale = nextScale
    }
  } finally {
    decoded.close?.()
  }
}

/** Replace (or append) the filename extension to match an encoded blob's type. */
function withExtension(name: string, type: string): string {
  const extension = ENCODED_EXTENSIONS[type]
  if (extension === undefined) return name
  const stem = name.replace(/\.[^.]*$/, '')
  return `${stem === '' ? 'wallpaper' : stem}${extension}`
}

/**
 * Prepare one picked file for `POST /skin-background/upload`: files within
 * the cap pass through untouched; oversized files compress toward the cap
 * and come back as a File carrying the encoded type and extension. Resolves
 * null when the file is undecodable or still over the cap after the full
 * ladder (the Host route refuses it anyway — this just saves the wire trip).
 */
export async function prepareUploadFile(
  file: File,
  deps: CompressDeps = defaultCompressDeps(),
): Promise<File | null> {
  if (file.size <= UPLOAD_MAX_BYTES) return file
  const blob = await compressImageToCap(file, UPLOAD_MAX_BYTES, deps)
  if (blob === null) return null
  return new File([blob], withExtension(file.name, blob.type), { type: blob.type })
}
