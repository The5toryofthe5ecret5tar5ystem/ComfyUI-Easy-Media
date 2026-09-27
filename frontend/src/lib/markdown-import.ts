import type { MultiTrackContinuityMode, MultiTrackSegment } from '@/types/multitrack'
import { uuid } from './uuid'
import {
  getInheritedTaskSegmentContent,
  getSelectedTaskUserPromptPatch,
  MULTITRACK_DEFAULT_FRAME_RATE,
  MULTITRACK_DEFAULT_TASK_MODE,
  snapSecondsToFrame,
} from './multitrack-utils'

/**
 * Parse long-take prompt markdown into per-task-segment prompts.
 *
 * The companion "Long Take Prompt Writer" produces one section per segment:
 *
 *   ## SEGMENT 3 of 12 · context · 00:16–00:24 · images: shared (nothing to add)
 *
 *   ```
 *   subject_definitions: ...
 *   ```
 *
 * The block body is the prompt, the heading carries the continuity mode and the
 * timeline range. Files without headings still work: fenced blocks are used in
 * order, then `---` divided sections, then the whole document as one segment.
 */

/** H3 video latents only accept 17k + 5 frames (`nodes/minimax.py`). */
export const H3_GRID_STEP = 17
export const H3_GRID_OFFSET = 5
/** Documented trained range for the project length tooltip: ~124-362 frames. */
export const H3_MIN_TESTED_FRAMES = 124
export const H3_MAX_TESTED_FRAMES = 362
/** Guard rail: refuse absurd files rather than building a thousand segments. */
export const MARKDOWN_IMPORT_MAX_SEGMENTS = 120

export type MarkdownImportSource = 'headings' | 'fences' | 'dividers' | 'document'

export interface ImportedMarkdownSegment {
  /** 0-based position in the file. */
  order: number
  /** Heading text without the leading hashes, for summaries and tooltips. */
  label: string
  prompt: string
  continuity?: MultiTrackContinuityMode
  startSeconds?: number
  endSeconds?: number
  durationSeconds?: number
  /** Duration snapped onto the H3 17k+5 grid. */
  frames?: number
  imagesHint?: string
}

export interface MarkdownImportPlan {
  source: MarkdownImportSource
  frameRate: number
  segments: ImportedMarkdownSegment[]
  warnings: string[]
  /** Sum of the snapped segment lengths, or 0 when no durations were found. */
  totalFrames: number
  /** Duration applied to segments whose heading carried no time range. */
  uniformDurationSeconds?: number
}

export interface BuildImportedTaskSegmentsOptions {
  existing?: MultiTrackSegment[]
  color: string
  frameRate?: number
  /** Track length used when the file carries no time ranges. */
  totalFrames?: number
  /** `replace` swaps the whole task track, `append` adds after the last segment. */
  mode?: 'replace' | 'append'
}

const SEGMENT_HEADING_RE = /^[\s>*-]*#{0,6}\s*\**\s*segment\s+(\d+)\s*(?:of\s*(\d+))?\s*\**\s*([·|:—-]*\s*.*)$/i
const TIMECODE_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?/g
const FENCED_BLOCK_RE = /(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)/
const DIVIDER_RE = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/
const MIN_FALLBACK_SEGMENT_CHARS = 40

interface RawBlock {
  label: string
  meta: string
  lines: string[]
}

/** Nearest (or next-higher) `17k + 5` frame count. */
export function snapH3Frames(frames: number, mode: 'nearest' | 'up' = 'nearest'): number {
  const safe = Math.max(0, Math.round(frames))
  const steps = (safe - H3_GRID_OFFSET) / H3_GRID_STEP
  const k = mode === 'up' ? Math.ceil(steps) : Math.round(steps)
  return H3_GRID_STEP * Math.max(0, k) + H3_GRID_OFFSET
}

export function isH3FrameCount(frames: number): boolean {
  return Number.isFinite(frames) && frames >= H3_GRID_OFFSET && (frames - H3_GRID_OFFSET) % H3_GRID_STEP === 0
}

/** `00:08`, `0:08`, `00:00:08`, `00:08.5` → seconds. */
export function parseTimecodeSeconds(value: string): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?\s*$/.exec(value)
  if (!match) return null
  const [, first, second, third, fraction] = match
  const hasHours = third !== undefined
  const hours = hasHours ? Number(first) : 0
  const minutes = hasHours ? Number(second) : Number(first)
  const seconds = hasHours ? Number(third) : Number(second)
  const millis = fraction ? Number(fraction.padEnd(3, '0')) / 1000 : 0
  return hours * 3600 + minutes * 60 + seconds + millis
}

function detectContinuity(meta: string): MultiTrackContinuityMode | undefined {
  const lower = meta.toLowerCase()
  // context_swap first, otherwise `context` matches inside it.
  for (const mode of ['context_swap', 'context', 'shot'] as const) {
    if (new RegExp(`(^|[^a-z_])${mode}([^a-z_]|$)`, 'i').test(lower)) return mode
  }
  return undefined
}

function detectTimeRange(meta: string): { startSeconds?: number; endSeconds?: number } {
  TIMECODE_RE.lastIndex = 0
  const found: number[] = []
  let match: RegExpExecArray | null
  while ((match = TIMECODE_RE.exec(meta)) !== null) {
    const value = parseTimecodeSeconds(match[0])
    if (value !== null) found.push(value)
    if (found.length === 2) break
  }
  if (found.length === 0) return {}
  if (found.length === 1) return { startSeconds: found[0] }
  return { startSeconds: found[0], endSeconds: found[1] }
}

function detectImagesHint(meta: string): string | undefined {
  const match = /\bimages?\s*:\s*([^·|]+)/i.exec(meta)
  const hint = match?.[1]?.trim()
  return hint ? hint : undefined
}

function extractPrompt(block: RawBlock): string {
  const text = block.lines.join('\n')
  const fenced = FENCED_BLOCK_RE.exec(text)
  const body = fenced ? fenced[1] : text
  return trimPrompt(body)
}

function trimPrompt(value: string): string {
  return value
    .replace(/^\s*(?:```|~~~)[^\n]*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .trim()
}

function splitIntoBlocks(text: string): RawBlock[] {
  const blocks: RawBlock[] = []
  let current: RawBlock | null = null
  for (const line of text.split(/\r?\n/)) {
    const heading = SEGMENT_HEADING_RE.exec(line)
    if (heading) {
      if (current) blocks.push(current)
      current = { label: line.replace(/^[\s>*-]+/, '').trim(), meta: heading[3] ?? '', lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) blocks.push(current)
  return blocks
}

function splitByFences(text: string): string[] {
  const parts: string[] = []
  const pattern = /(?:^|\n)[ \t]*(?:```|~~~)[^\n]*\n([\s\S]*?)(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) parts.push(trimPrompt(match[1]))
  return parts.filter(Boolean)
}

function splitByDividers(text: string): string[] {
  return text
    .split(/\r?\n/)
    .reduce<string[][]>((chunks, line) => {
      if (DIVIDER_RE.test(line)) chunks.push([])
      else chunks[chunks.length - 1].push(line)
      return chunks
    }, [[]])
    .map((chunk) => trimPrompt(chunk.join('\n')))
    .filter((chunk) => chunk.length >= MIN_FALLBACK_SEGMENT_CHARS)
}

function takePrompts(text: string): Pick<MarkdownImportPlan, 'segments' | 'source' | 'warnings'> {
  const warnings: string[] = []
  const blocks = splitIntoBlocks(text)
  const segments: ImportedMarkdownSegment[] = []

  if (blocks.length > 0) {
    blocks.forEach((block, index) => {
      const prompt = extractPrompt(block)
      if (!prompt) {
        warnings.push(`Segment ${index + 1} heading has no prompt body and was skipped.`)
        return
      }
      const range = detectTimeRange(block.meta || block.label)
      const continuity = detectContinuity(block.meta || block.label)
      segments.push({
        order: segments.length,
        label: block.label,
        prompt,
        continuity,
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
        imagesHint: detectImagesHint(block.meta || block.label),
      })
    })
    if (segments.length > 0) return { segments, source: 'headings', warnings }
    warnings.push('Found segment headings but no prompt bodies; falling back to fenced blocks.')
  }

  const fenced = splitByFences(text)
  if (fenced.length > 0) {
    if (blocks.length === 0) warnings.push('No "SEGMENT n" headings found; used fenced code blocks in order.')
    return {
      segments: fenced.map((prompt, index) => ({ order: index, label: `Segment ${index + 1}`, prompt })),
      source: 'fences',
      warnings,
    }
  }

  const divided = splitByDividers(text)
  if (divided.length > 1) {
    warnings.push('No segment headings or code blocks found; split on horizontal rules.')
    return {
      segments: divided.map((prompt, index) => ({ order: index, label: `Segment ${index + 1}`, prompt })),
      source: 'dividers',
      warnings,
    }
  }

  const single = trimPrompt(text)
  if (!single) {
    return { segments: [], source: 'document', warnings: ['The file contains no prompt text.'] }
  }
  warnings.push('No segment boundaries found; the whole file was used as ONE segment.')
  return {
    segments: [{ order: 0, label: 'Segment 1', prompt: single }],
    source: 'document',
    warnings,
  }
}

function resolveDurations(segments: ImportedMarkdownSegment[], frameRate: number, warnings: string[]): number {
  const durations = segments.map((segment) => {
    if (segment.startSeconds === undefined || segment.endSeconds === undefined) return undefined
    const duration = segment.endSeconds - segment.startSeconds
    return duration > 0 ? duration : undefined
  })
  const known = durations.filter((value): value is number => value !== undefined)
  const uniform = known.length === durations.length && known.length > 0 ? known[0] : undefined
  let total = 0
  let hasFrames = true

  segments.forEach((segment, index) => {
    let duration = durations[index]
    if (duration === undefined && uniform !== undefined) duration = uniform
    if (duration === undefined) {
      hasFrames = false
      return
    }
    segment.durationSeconds = duration
    const rawFrames = snapSecondsToFrame(duration, frameRate)
    const frames = snapH3Frames(rawFrames)
    segment.frames = frames
    total += frames
    if (frames !== rawFrames) {
      warnings.push(
        `Segment ${segment.order + 1}: ${duration.toFixed(2)}s snapped to ${frames} frames (${(frames / frameRate).toFixed(2)}s) for H3's 17k+5 grid.`,
      )
    }
    if (frames > H3_MAX_TESTED_FRAMES) {
      warnings.push(`Segment ${segment.order + 1}: ${frames} frames exceeds the documented trained range (<= ${H3_MAX_TESTED_FRAMES}).`)
    } else if (frames < H3_MIN_TESTED_FRAMES) {
      warnings.push(`Segment ${segment.order + 1}: ${frames} frames is below the documented trained range (>= ${H3_MIN_TESTED_FRAMES}).`)
    }
  })

  if (!hasFrames) {
    warnings.push('No time ranges found in the file; the imported segments will share the current track length evenly.')
    return 0
  }
  return total
}

export function parseLongTakeMarkdown(text: string, options: { frameRate?: number } = {}): MarkdownImportPlan {
  const frameRate = options.frameRate && options.frameRate > 0 ? options.frameRate : MULTITRACK_DEFAULT_FRAME_RATE
  const { segments, source, warnings } = takePrompts(text)

  if (segments.length > MARKDOWN_IMPORT_MAX_SEGMENTS) {
    const dropped = segments.length - MARKDOWN_IMPORT_MAX_SEGMENTS
    segments.length = MARKDOWN_IMPORT_MAX_SEGMENTS
    warnings.push(`Only the first ${MARKDOWN_IMPORT_MAX_SEGMENTS} segments were imported (${dropped} dropped).`)
  }

  const pipes = segments.filter((segment) => /[|｜]/.test(segment.prompt)).length
  if (pipes > 0) {
    warnings.push(
      `${pipes} prompt(s) contain a "|" character, which the Combined editor uses as its separator. Imported prompts are unaffected, but avoid Combined mode for this file.`,
    )
  }

  const totalFrames = resolveDurations(segments, frameRate, warnings)
  const explicit = segments.filter((segment) => segment.frames !== undefined)
  const uniformDurationSeconds = explicit.length > 0
    && new Set(segments.map((segment) => segment.durationSeconds)).size === 1
    ? segments[0]?.durationSeconds
    : undefined

  return { source, frameRate, segments, warnings, totalFrames, uniformDurationSeconds }
}

/** The same plan as a Combined-editor paste string. */
export function planToCombinedText(plan: MarkdownImportPlan): string {
  return plan.segments.map((segment) => segment.prompt).join('|')
}

/**
 * Read a dropped or picked file as text.
 *
 * `Blob.text()` is preferred where it exists; older WebViews and the jsdom test
 * environment only ship `FileReader`, so fall back to it instead of failing.
 */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsText(file)
  })
}

function distributeFrames(segments: ImportedMarkdownSegment[], totalFrames: number, frameRate: number): number[] {
  const target = Math.max(segments.length, Math.round(totalFrames))
  const base = Math.floor(target / segments.length)
  const remainder = target % segments.length
  return segments.map((_, index) => {
    const raw = base + (index < remainder ? 1 : 0)
    const snapped = snapH3Frames(raw)
    return snapped > 0 ? snapped : Math.max(1, raw || frameRate)
  })
}

/**
 * Turn a parsed plan into task segments, keeping the settings (task mode, ref
 * size, images, prompt variant) of the segment the import was started from.
 */
export function buildImportedTaskSegments(
  plan: MarkdownImportPlan,
  options: BuildImportedTaskSegmentsOptions,
): MultiTrackSegment[] {
  const { existing = [], color, mode = 'replace', totalFrames = 0 } = options
  const frameRate = options.frameRate ?? plan.frameRate ?? MULTITRACK_DEFAULT_FRAME_RATE
  const ordered = [...existing].sort((left, right) => left.start_frame - right.start_frame)
  const template = ordered[0]
  const templateContent = template?.content
  const variantSeed = templateContent ?? { media_type: 'none' as const }

  const fallbackSpan = totalFrames > 0
    ? totalFrames
    : Math.round(frameRate * 8) * plan.segments.length
  const lengths = plan.totalFrames > 0
    ? plan.segments.map((segment) => segment.frames ?? 0)
    : distributeFrames(plan.segments, fallbackSpan, frameRate)

  const startAt = mode === 'append'
    ? ordered.reduce((max, item) => Math.max(max, item.end_frame), 0)
    : 0

  const built: MultiTrackSegment[] = []
  let cursor = startAt
  plan.segments.forEach((segment, index) => {
    const start = cursor
    const end = cursor + Math.max(1, lengths[index] ?? 0)
    cursor = end
    const inherited = getInheritedTaskSegmentContent(
      [...(mode === 'append' ? ordered : []), ...built],
      start,
      templateContent?.task_mode ?? MULTITRACK_DEFAULT_TASK_MODE,
    )
    built.push({
      id: uuid(),
      start_frame: start,
      end_frame: end,
      color: template?.color ?? color,
      content: {
        media_type: 'none',
        ...inherited,
        ...(templateContent?.images ? { images: templateContent.images.map((image) => ({ ...image })) } : {}),
        ...(templateContent?.ref_image_size ? { ref_image_size: templateContent.ref_image_size } : {}),
        continuity_mode: segment.continuity ?? (index === 0 ? 'shot' : 'context'),
        ...getSelectedTaskUserPromptPatch(variantSeed, segment.prompt),
      },
    })
  })

  return mode === 'append' ? [...ordered, ...built] : built
}

/** Human summary for the confirmation dialog. */
export function describeImportPlan(plan: MarkdownImportPlan): string {
  const count = plan.segments.length
  if (count === 0) return '0 segments'
  const lengths = plan.segments.map((segment) => segment.frames)
  const uniform = lengths.every((value) => value === lengths[0]) && lengths[0] !== undefined
  const seconds = uniform && lengths[0] !== undefined
    ? `${(lengths[0] / plan.frameRate).toFixed(2)}s each`
    : `${(plan.totalFrames / plan.frameRate).toFixed(1)}s total`
  return `${count} segment${count === 1 ? '' : 's'} · ${seconds}`
}
