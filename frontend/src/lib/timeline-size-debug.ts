/**
 * Opt-in instrumentation for tracking down unexpected timeline node resizes.
 *
 * Enable it once in the browser console, then reload:
 *
 *   localStorage.setItem('easyMedia.sizeDebug', '1'); location.reload()
 *
 * Import a markdown, then copy the captured log:
 *
 *   copy(JSON.stringify(window.__easyMediaSizeLog, null, 2))
 *
 * Disable with `localStorage.removeItem('easyMedia.sizeDebug')`.
 *
 * Recording is limited to the node that installs it and to a bounded ring buffer,
 * so it is safe to leave running while debugging.
 */

const DEBUG_FLAG = 'easyMedia.sizeDebug'
const DEBUG_LOG_FILE = 'easymedia_size_debug.json'
const LOG_LIMIT = 800

export interface TimelineSizeDebugEntry {
  t: number
  tag: string
  size: [number, number] | null
  sizeRaw?: string
  sizeKind?: string
  storedHeight?: number | null
  widgetHeight?: number | null
  bodyHeight?: number | null
  elementHeight?: number | null
  wrapperStyle?: string | null
  stack?: string[]
}

interface DebugWindow {
  __easyMediaSizeLog?: TimelineSizeDebugEntry[]
}

function debugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEBUG_FLAG) === '1'
  } catch {
    return false
  }
}

function readSize(size: unknown): [number, number] | null {
  if (Array.isArray(size) && size.length >= 2) return [Number(size[0]), Number(size[1])]
  if (ArrayBuffer.isView(size) && Number((size as unknown as ArrayLike<number>).length) >= 2) {
    const arrayLike = size as unknown as ArrayLike<number>
    const width = Number(arrayLike[0])
    const height = Number(arrayLike[1])
    return Number.isFinite(width) && Number.isFinite(height) ? [width, height] : null
  }
  if (size && typeof size === 'object') {
    const candidate = size as Record<string, unknown>
    const width = Number(candidate.width ?? candidate[0])
    const height = Number(candidate.height ?? candidate[1])
    if (Number.isFinite(width) && Number.isFinite(height)) return [width, height]
  }
  return null
}

/** Describes the runtime shape of `node.size` so the log is self-explanatory. */
function describeSize(size: unknown): string {
  if (Array.isArray(size)) return `Array(${size.length})`
  if (ArrayBuffer.isView(size)) return size.constructor?.name ?? 'TypedArray'
  if (size && typeof size === 'object') return `Object{${Object.keys(size as object).join(',')}}`
  return String(size)
}

/** Walks the prototype chain looking for the descriptor that backs a property. */
function findDescriptor(target: unknown, key: string): PropertyDescriptor | null {
  let current = target as object | null
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) return descriptor
    current = Object.getPrototypeOf(current) as object | null
  }
  return null
}

function stackLines(): string[] {
  const stack = new Error().stack ?? ''
  return stack.split('\n').slice(2, 8).map((line) => line.trim().slice(0, 160))
}

function heightRange(values: unknown[]): [number, number] | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (numbers.length === 0) return null
  return [Math.min(...numbers), Math.max(...numbers)]
}

/**
 * Stores the captured log in the ComfyUI user directory (`user/easymedia_size_debug.json`)
 * so it can be inspected from disk without pasting hundreds of lines.
 */
async function uploadLog(log: TimelineSizeDebugEntry[]): Promise<void> {
  const summary = {
    capturedAt: new Date().toISOString(),
    entryCount: log.length,
    tags: [...new Set(log.map((entry) => entry.tag))],
    heightRange: heightRange(log.map((entry) => entry.size?.[1] ?? null)),
    widgetHeightRange: heightRange(log.map((entry) => entry.widgetHeight ?? null)),
    elementHeightRange: heightRange(log.map((entry) => entry.elementHeight ?? null)),
  }
  const body = JSON.stringify({ summary, entries: log }, null, 2)
  const api = (globalThis as {
    app?: { api?: { fetchApi?: (url: string, init?: unknown) => Promise<Response> } }
  }).app?.api
  try {
    // Call fetchApi as a method: it reads `this.user`, so an unbound call throws.
    const response = typeof api?.fetchApi === 'function'
      ? await api.fetchApi(`/userdata/${DEBUG_LOG_FILE}`, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/json' },
        })
      : await fetch(`/userdata/${DEBUG_LOG_FILE}`, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/json' },
        })
    if (response?.ok) {
      console.info(`[easyMedia] size debug log written to user/${DEBUG_LOG_FILE}`, summary)
    } else {
      console.warn('[easyMedia] size debug upload failed', response?.status, summary)
    }
  } catch (error) {
    console.warn('[easyMedia] size debug upload threw', error, summary)
  }
}

export function isTimelineSizeDebugEnabled(): boolean {
  return debugEnabled()
}

let activeDebug: { record: (tag: string, burstMs?: number) => void } | null = null

/** Marks a moment in the log (used around the markdown import). */
export function markTimelineSizeDebug(tag: string, burstMs = 3000): void {
  activeDebug?.record(tag, burstMs)
}

/** Records size writes on one node: setSize, onResize, onWidgetChanged and any layout change. */
export function startTimelineSizeDebug(node: any, label: string): () => void {
  if (!debugEnabled() || !node) return () => {}

  const win = globalThis as DebugWindow
  win.__easyMediaSizeLog ??= []
  const log = win.__easyMediaSizeLog

  const readWidget = () => node.widgets?.find((entry: any) => entry?.name === 'track_data')
  const readElement = (): HTMLElement | undefined => {
    const widget = readWidget()
    return (widget?.element ?? widget?.inputEl) as HTMLElement | undefined
  }
  const rawSize = (): string => {
    try {
      return JSON.stringify(node.size ?? null)
    } catch {
      return describeSize(node.size)
    }
  }
  const record = (tag: string, includeStack = true) => {
    const widget = readWidget()
    const element = readElement()
    const wrapper = element?.parentElement ?? null
    log.push({
      t: Date.now(),
      tag: `${label}:${tag}`,
      size: readSize(node.size),
      sizeRaw: rawSize(),
      sizeKind: describeSize(node.size),
      storedHeight: node.properties?.easyMediaTimelineHeight ?? null,
      widgetHeight: widget?.computedHeight ?? null,
      bodyHeight: node.bodyHeight ?? null,
      elementHeight: element ? Math.round(element.getBoundingClientRect().height) : null,
      wrapperStyle: wrapper?.getAttribute('style') ?? null,
      ...(includeStack ? { stack: stackLines() } : {}),
    })
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
  }

  record('install')
  console.info('[easyMedia] size debug recording enabled', {
    sizeKind: describeSize(node.size),
    size: rawSize(),
    bodyHeight: node.bodyHeight,
  })
  // Frame sampler: catches layout changes that never call setSize (in-place writes, re-measure).
  let samplerFrame = 0
  let samplerActive = true
  let burstUntil = 0
  let burstPending = false
  let lastSignature = ''
  const sample = () => {
    if (!samplerActive) return
    const widget = readWidget()
    const element = readElement()
    const signature = [
      rawSize(),
      widget?.computedHeight ?? '',
      node.bodyHeight ?? '',
      element ? Math.round(element.getBoundingClientRect().height) : '',
    ].join('|')
    if (signature !== lastSignature) {
      lastSignature = signature
      record('sample')
    } else if (Date.now() < burstUntil) {
      // During a burst every frame is logged so a one-frame flicker cannot hide.
      record('burst', false)
    } else if (burstPending) {
      burstPending = false
      void uploadLog(log)
    }
    samplerFrame = globalThis.requestAnimationFrame(sample)
  }
  samplerFrame = globalThis.requestAnimationFrame(sample)

  const originalSetSize = typeof node.setSize === 'function' ? node.setSize : null
  if (originalSetSize) {
    node.setSize = function patchedSetSize(this: any, size: unknown, ...rest: unknown[]) {
      const before = readSize(node.size)
      const result = originalSetSize.call(this, size, ...rest)
      const after = readSize(node.size)
      if (!before || !after || before[1] !== after[1]) {
        record(`setSize(${JSON.stringify(readSize(size))})`)
      }
      return result
    }
  }

  const originalOnResize = typeof node.onResize === 'function' ? node.onResize : null
  if (originalOnResize) {
    node.onResize = function patchedOnResize(this: any, size: unknown, ...rest: unknown[]) {
      const result = originalOnResize.call(this, size, ...rest)
      record('onResize')
      return result
    }
  }

  const originalOnWidgetChanged = typeof node.onWidgetChanged === 'function' ? node.onWidgetChanged : null
  if (originalOnWidgetChanged) {
    node.onWidgetChanged = function patchedOnWidgetChanged(this: any, name: string, ...rest: unknown[]) {
      record(`onWidgetChanged(${String(name)})`)
      return originalOnWidgetChanged.call(this, name, ...rest)
    }
  }

  activeDebug = {
    record: (tag: string, burstMs?: number) => {
      if (burstMs) {
        burstUntil = Date.now() + burstMs
        burstPending = true
      }
      record(tag)
    },
  }

  /**
   * In-place writes (`node.size[1] = x`) never touch setSize or onResize, which is how the
   * node can shrink without any of the usual hooks firing. Watch the live size object's
   * numeric keys directly - the object identity is preserved, so behaviour is unchanged.
   */
  let patchedSizeObject: any = null
  const patchSizeIndexes = (target: any) => {
    if (!target || typeof target !== 'object' || target === patchedSizeObject) return
    patchedSizeObject = target
    for (const key of ['0', '1'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      if (descriptor && !descriptor.writable && !descriptor.set) continue
      let store = descriptor?.value ?? target[key]
      try {
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          get: () => store,
          set: (value: unknown) => {
            const previous = Number(store)
            store = value
            if (!Number.isFinite(previous) || previous !== Number(value)) {
              record(`size[${key}]=${String(value)}`)
            }
          },
        })
      } catch (error) {
        // `node.size` is a Vue reactive Proxy whose defineProperty trap can reject this;
        // the frame sampler still catches the write, so stay quiet.
        console.debug('[easyMedia] size index patch skipped', key, error)
      }
    }
  }

  // Whole-value replacement (`node.size = [...]`) bypasses setSize too. Forward to the
  // original descriptor so the accessor is transparent, and log the new value.
  const sizeDescriptor = findDescriptor(node, 'size')
  let sizeStore = node.size
  try {
    Object.defineProperty(node, 'size', {
      configurable: true,
      enumerable: sizeDescriptor?.enumerable ?? false,
      get(this: any) {
        return sizeDescriptor?.get ? sizeDescriptor.get.call(this) : sizeStore
      },
      set(this: any, value: unknown) {
        const before = readSize(this.size)
        const after = readSize(value)
        if (sizeDescriptor?.set) sizeDescriptor.set.call(this, value)
        else sizeStore = value
        if (!before || !after || before[1] !== after[1]) record(`size=${JSON.stringify(after)}`)
        if (sizeDescriptor?.set) patchSizeIndexes(this.size)
        else patchSizeIndexes(value)
      },
    })
  } catch (error) {
    console.debug('[easyMedia] size accessor patch skipped', error)
  }
  patchSizeIndexes(node.size)

  // Manual escape hatch: `window.__easyMediaSizeDebugUpload()` writes the log to disk.
  const debugWindow = globalThis as DebugWindow & { __easyMediaSizeDebugUpload?: () => Promise<void> }
  debugWindow.__easyMediaSizeDebugUpload = () => uploadLog(log)

  return () => {
    samplerActive = false
    activeDebug = null
    if (debugWindow.__easyMediaSizeDebugUpload) delete debugWindow.__easyMediaSizeDebugUpload
    if (samplerFrame) globalThis.cancelAnimationFrame(samplerFrame)
    if (sizeDescriptor) Object.defineProperty(node, 'size', { ...sizeDescriptor, configurable: true })
    else node.size = sizeStore
    if (originalSetSize) node.setSize = originalSetSize
    else delete node.setSize
    if (originalOnResize) node.onResize = originalOnResize
    if (originalOnWidgetChanged) node.onWidgetChanged = originalOnWidgetChanged
  }
}
