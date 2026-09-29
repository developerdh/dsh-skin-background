// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { FALLBACK_WALLPAPER_URL } from '../src/skin-settings.ts'
import {
  SKIN_ACTIVE_CLASS, SKIN_STYLE_TAG, SKIN_BASE_TOKEN_OVERRIDES, SKIN_GLASS_TOKEN_OVERRIDES, SkinController,
  type ThemeOverrideService,
} from '../src/client/SkinController.ts'

interface RecordedLayer {
  source: string
  tokens: Record<string, { light: string; dark: string }>
}

function createTheme(): { theme: ThemeOverrideService; layers: RecordedLayer[]; disposed: number } {
  const layers: RecordedLayer[] = []
  let disposed = 0
  const theme: ThemeOverrideService = {
    overrideTokens: (source, tokens) => {
      const layer = { source, tokens }
      layers.push(layer)
      return () => { disposed += 1 }
    },
  }
  return { theme, layers, get disposed() { return disposed } }
}

function controller(): { skin: SkinController; theme: ReturnType<typeof createTheme> } {
  const harness = createTheme()
  return { skin: new SkinController({ document, theme: harness.theme }), theme: harness }
}

const vars = (): Record<string, string> => {
  const style = document.documentElement.style
  const names = ['--dsh-skin-image', '--dsh-skin-dim-light', '--dsh-skin-dim-dark', '--dsh-skin-blur', '--dsh-skin-bleed']
  return Object.fromEntries(names.map(name => [name, style.getPropertyValue(name)]))
}

const styleTag = (): HTMLStyleElement | null =>
  document.querySelector(`style[data-plugin-css="${SKIN_STYLE_TAG}"]`)

const activeLayers = (theme: ReturnType<typeof createTheme>): RecordedLayer[] => theme.layers.slice(theme.disposed)

describe('SkinController', () => {
  it('applies the base token layer (canvas + sidebar) with the wallpaper by default', () => {
    const { skin, theme } = controller()
    skin.apply({ enabled: true, image: '', dim: 0.4, blur: 6 })
    expect(styleTag()?.dataset.plugin).toBe('dsh-skin-background')
    expect(styleTag()?.textContent).toContain('body.dsh-skin-active::before')
    expect(document.body.classList.contains(SKIN_ACTIVE_CLASS)).toBe(true)
    expect(vars()['--dsh-skin-image']).toBe(`url("${FALLBACK_WALLPAPER_URL}")`)
    expect(vars()['--dsh-skin-dim-light']).toBe('rgba(255,255,255,0.4)')
    expect(vars()['--dsh-skin-dim-dark']).toBe('rgba(6,8,14,0.55)')
    expect(vars()['--dsh-skin-blur']).toBe('6px')
    expect(vars()['--dsh-skin-bleed']).toBe('6px')
    // The base layer (canvas + sidebar) is the skin's core visual and is
    // always on; the glass layer is opt-in and absent by default.
    expect(activeLayers(theme)).toHaveLength(1)
    expect(activeLayers(theme)[0].source).toBe('dsh-skin-background')
    expect(activeLayers(theme)[0].tokens).toEqual(SKIN_BASE_TOKEN_OVERRIDES)
    expect(theme.layers.some(layer => layer.source === 'dsh-skin-background:glass')).toBe(false)
  })

  it('adds the glass layer only while glass is on and keeps the base layer', () => {
    const { skin, theme } = controller()
    skin.apply({ enabled: true, glass: true })
    expect(activeLayers(theme)).toHaveLength(2)
    const glass = activeLayers(theme).find(layer => layer.source === 'dsh-skin-background:glass')
    expect(glass?.tokens).toEqual(SKIN_GLASS_TOKEN_OVERRIDES)
    // Re-applying with glass on replaces both layers instead of stacking.
    skin.apply({ enabled: true, image: '', dim: 0.2, blur: 0, glass: true })
    expect(theme.disposed).toBe(2)
    expect(activeLayers(theme)).toHaveLength(2)
    expect(vars()['--dsh-skin-dim-light']).toBe('rgba(255,255,255,0.2)')
    // Toggling glass off drops the glass layer; the base layer stays.
    skin.apply({ enabled: true, image: '', dim: 0.2, blur: 0, glass: false })
    expect(theme.disposed).toBe(4)
    expect(activeLayers(theme)).toHaveLength(1)
    expect(activeLayers(theme)[0].source).toBe('dsh-skin-background')
    expect(document.body.classList.contains(SKIN_ACTIVE_CLASS)).toBe(true)
  })

  it('resolves preset references once the wallpaper list arrives', () => {
    const { skin } = controller()
    skin.apply({ enabled: true, image: 'preset:dusk-drift', dim: 0.3, blur: 0 })
    expect(vars()['--dsh-skin-image']).toBe(`url("${FALLBACK_WALLPAPER_URL}")`)
    skin.applyWallpapers([
      { id: 'dusk-drift', name: 'dusk drift', url: '/skin-background/wallpapers/dusk-drift.svg', source: 'builtin' },
    ])
    expect(vars()['--dsh-skin-image']).toBe('url("/skin-background/wallpapers/dusk-drift.svg")')
  })

  it('passes valid http URLs through and repairs garbage settings', () => {
    const { skin } = controller()
    skin.apply({ enabled: true, image: 'https://cdn.example.com/w.jpg', dim: 9, blur: -4 })
    expect(vars()['--dsh-skin-image']).toBe('url("https://cdn.example.com/w.jpg")')
    expect(vars()['--dsh-skin-dim-light']).toBe('rgba(255,255,255,0.9)')
    expect(vars()['--dsh-skin-blur']).toBe('0px')
    // A garbage enabled flag resolves to disabled, which deactivates the layer.
    skin.apply({ enabled: 'nope', image: 'javascript:alert(1)' })
    expect(vars()['--dsh-skin-image']).toBe('')
    expect(document.body.classList.contains(SKIN_ACTIVE_CLASS)).toBe(false)
  })

  it('deactivates on disable and fully reverts on dispose', () => {
    const { skin, theme } = controller()
    skin.apply({ enabled: true, glass: true })
    skin.apply({ enabled: false })
    expect(document.body.classList.contains(SKIN_ACTIVE_CLASS)).toBe(false)
    expect(vars()['--dsh-skin-image']).toBe('')
    expect(theme.disposed).toBe(2) // base + glass layers both dropped
    expect(styleTag()).not.toBeNull() // plugin still loaded; style tag stays

    skin.apply({ enabled: true, glass: true })
    expect(activeLayers(theme)).toHaveLength(2)
    skin.dispose()
    expect(theme.disposed).toBe(4)
    expect(document.body.classList.contains(SKIN_ACTIVE_CLASS)).toBe(false)
    expect(styleTag()).toBeNull()
  })
})
