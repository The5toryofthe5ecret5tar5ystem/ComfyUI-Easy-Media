import { describe, expect, it } from 'vitest'
import {
  buildImportedProject,
  buildImportedTaskSegments,
  describeImportPlan,
  isH3FrameCount,
  MARKDOWN_IMPORT_MAX_SEGMENTS,
  MEGAPIXEL_RESOLUTION_LABEL,
  parseLongTakeMarkdown,
  parseProjectSettings,
  parseTimecodeSeconds,
  planToCombinedText,
  snapH3Frames,
} from '@/lib/markdown-import'
import type { MultiTrackSegment } from '@/types/multitrack'

const EN_DASH = '\u2013'

function guideFile(segments: Array<{ mode?: string; start: string; end: string; images?: string; body?: string }>): string {
  const total = segments.length
  const first = segments[0]
  const length = first ? parseTimecodeSeconds(first.end) !== null && parseTimecodeSeconds(first.start) !== null
    ? Number(parseTimecodeSeconds(first.end)) - Number(parseTimecodeSeconds(first.start))
    : 8 : 8
  const preamble = [
    `Setup: ${total} segments of ${length} s, resolution 1.2 MP, 16:9. Task mode \`ref\` everywhere;`,
    `continuity \`shot\` on segment 1 and \`context\` on 2-${total}. \`ref_image_size = max\`.`,
    'Refs on segment 1 only, shared. `segment_start_number = 1`, `sampling_mode = single`.',
  ].join(' ')
  const sections = segments.map((segment, index) => {
    const parts = [`SEGMENT ${index + 1} of ${total}`, segment.mode, `${segment.start}${EN_DASH}${segment.end}`]
    if (segment.images) parts.push(`images: ${segment.images}`)
    return [
      `## ${parts.filter(Boolean).join(' · ')}`,
      '',
      '```',
      segment.body ?? `subject_definitions: subject ${index + 1}\n\nsummary:\n[reference generation] beat ${index + 1}.`,
      '```',
      '',
    ].join('\n')
  })
  return ['# Elevator — Long Take prompts', '', preamble, '', '---', '', '# The prompts', '', ...sections].join('\n')
}

function taskSegment(overrides: Partial<MultiTrackSegment['content']> = {}): MultiTrackSegment {
  return {
    id: 'template-segment',
    start_frame: 0,
    end_frame: 96,
    color: 'var(--primary)',
    content: {
      media_type: 'none',
      task_mode: 'ref',
      continuity_mode: 'shot',
      ref_image_size: 'max',
      user_prompt: 'old prompt',
      images: [{ id: 'img-1', source_type: 'input', file_path: 'headshot.png' }],
      ...overrides,
    },
  }
}

describe('snapH3Frames', () => {
  it('keeps frame counts that already sit on the 17k+5 grid', () => {
    expect(snapH3Frames(192)).toBe(192)
    expect(snapH3Frames(124)).toBe(124)
    expect(isH3FrameCount(192)).toBe(true)
    expect(isH3FrameCount(288)).toBe(false)
  })

  it('snaps off-grid counts to the nearest grid value', () => {
    expect(snapH3Frames(288)).toBe(294)
    expect(snapH3Frames(100)).toBe(107)
  })

  it('can round up instead of to nearest', () => {
    expect(snapH3Frames(288, 'up')).toBe(294)
    expect(snapH3Frames(290, 'up')).toBe(294)
  })

  it('never returns a negative count', () => {
    expect(snapH3Frames(-10)).toBe(5)
  })
})

describe('parseTimecodeSeconds', () => {
  it('parses mm:ss, hh:mm:ss and fractional seconds', () => {
    expect(parseTimecodeSeconds('00:08')).toBe(8)
    expect(parseTimecodeSeconds('1:30')).toBe(90)
    expect(parseTimecodeSeconds('00:00:04.500')).toBe(4.5)
    expect(parseTimecodeSeconds('00:08,25')).toBe(8.25)
  })

  it('returns null for anything else', () => {
    expect(parseTimecodeSeconds('later')).toBeNull()
    expect(parseTimecodeSeconds('')).toBeNull()
  })
})

describe('parseLongTakeMarkdown', () => {
  it('reads the guide layout: one heading per segment with mode, range and images', () => {
    const plan = parseLongTakeMarkdown(guideFile([
      { mode: 'shot', start: '00:00', end: '00:08', images: 'headshot + character sheet' },
      { mode: 'context', start: '00:08', end: '00:16', images: 'shared (nothing to add)' },
      { mode: 'context_swap', start: '00:16', end: '00:24' },
    ]))

    expect(plan.source).toBe('headings')
    expect(plan.segments).toHaveLength(3)
    expect(plan.segments.map((segment) => segment.continuity)).toEqual(['shot', 'context', 'context_swap'])
    expect(plan.segments.map((segment) => segment.frames)).toEqual([192, 192, 192])
    expect(plan.totalFrames).toBe(576)
    expect(plan.segments[0].imagesHint).toBe('headshot + character sheet')
    expect(plan.segments[0].prompt).toContain('subject_definitions: subject 1')
    expect(plan.warnings).toEqual([])
  })

  it('handles a twelve segment file and reports a uniform length', () => {
    const plan = parseLongTakeMarkdown(guideFile(
      Array.from({ length: 12 }, (_, index) => ({
        mode: index === 0 ? 'shot' : 'context',
        start: `00:${String(index * 8).padStart(2, '0')}`,
        end: `00:${String((index + 1) * 8).padStart(2, '0')}`,
      })),
    ))

    expect(plan.segments).toHaveLength(12)
    expect(plan.totalFrames).toBe(2304)
    expect(plan.uniformDurationSeconds).toBe(8)
    expect(plan.settings.megapixels).toBe(1.2)
    expect(plan.settings.aspectRatio).toBe('16:9 (Widescreen)')
    expect(plan.settings.taskMode).toBe('ref')
    expect(describeImportPlan(plan)).toBe('12 segments · 8.00s each · 1.2 MP 16:9 (Widescreen) · ref')
  })

  it('does not confuse context_swap with context', () => {
    const plan = parseLongTakeMarkdown(guideFile([{ mode: 'context_swap', start: '00:00', end: '00:08' }]))
    expect(plan.segments[0].continuity).toBe('context_swap')
  })

  it('leaves continuity undefined when the heading does not name a mode', () => {
    const plan = parseLongTakeMarkdown(['## SEGMENT 1 of 2', '', '```', 'prompt one', '```'].join('\n'))
    expect(plan.segments[0].continuity).toBeUndefined()
  })

  it('warns when durations are missing instead of inventing boundaries', () => {
    const plan = parseLongTakeMarkdown([
      '## SEGMENT 1 of 2 · context',
      '',
      '```',
      'prompt one',
      '```',
      '',
      '## SEGMENT 2 of 2 · context',
      '',
      '```',
      'prompt two',
      '```',
    ].join('\n'))

    expect(plan.totalFrames).toBe(0)
    expect(plan.segments).toHaveLength(2)
    expect(plan.warnings.some((warning) => warning.includes('share the current track length evenly'))).toBe(true)
  })

  it('falls back to fenced blocks when there are no segment headings', () => {
    const plan = parseLongTakeMarkdown([
      '# My take',
      '',
      '```',
      'first prompt',
      '```',
      '',
      'some notes between the prompts',
      '',
      '```',
      'second prompt',
      '```',
    ].join('\n'))

    expect(plan.source).toBe('fences')
    expect(plan.segments.map((segment) => segment.prompt)).toEqual(['first prompt', 'second prompt'])
    expect(plan.warnings.some((warning) => warning.includes('No "SEGMENT n" headings'))).toBe(true)
  })

  it('falls back to horizontal rules and then to the whole document', () => {
    const divided = parseLongTakeMarkdown([
      'first section body that is comfortably longer than the minimum chunk length',
      '',
      '---',
      '',
      'second section body that is comfortably longer than the minimum chunk length',
    ].join('\n'))
    expect(divided.source).toBe('dividers')
    expect(divided.segments).toHaveLength(2)

    const single = parseLongTakeMarkdown('just one prompt with no structure at all')
    expect(single.source).toBe('document')
    expect(single.segments).toHaveLength(1)
    expect(single.warnings.some((warning) => warning.includes('ONE segment'))).toBe(true)
  })

  it('warns about "|" characters and caps the segment count', () => {
    const piped = parseLongTakeMarkdown(guideFile([{ mode: 'shot', start: '00:00', end: '00:08', body: 'a | b' }]))
    expect(piped.warnings.some((warning) => warning.includes('Combined'))).toBe(true)

    const many = parseLongTakeMarkdown(guideFile(
      Array.from({ length: MARKDOWN_IMPORT_MAX_SEGMENTS + 5 }, (_, index) => ({
        mode: 'context',
        start: '00:00',
        end: '00:08',
        body: `prompt ${index}`,
      })),
    ))
    expect(many.segments).toHaveLength(MARKDOWN_IMPORT_MAX_SEGMENTS)
    expect(many.warnings.some((warning) => warning.includes('dropped'))).toBe(true)
  })

  it('warns when a segment leaves the documented trained length range', () => {
    const plan = parseLongTakeMarkdown(guideFile([{ mode: 'shot', start: '00:00', end: '00:20' }]))
    expect(plan.segments[0].frames).toBeGreaterThan(362)
    expect(plan.warnings.some((warning) => warning.includes('trained range'))).toBe(true)
  })

  it('exposes the same plan as a Combined-editor paste string', () => {
    const plan = parseLongTakeMarkdown(guideFile([
      { mode: 'shot', start: '00:00', end: '00:08', body: 'prompt one' },
      { mode: 'context', start: '00:08', end: '00:16', body: 'prompt two' },
    ]))
    expect(planToCombinedText(plan)).toBe('prompt one|prompt two')
  })
})

describe('parseProjectSettings', () => {
  it('reads resolution, fps, generator mode and reference sizing from the setup block', () => {
    const settings = parseProjectSettings([
      'Setup: 24 segments of 12.25 s, resolution 0.9 MP, 21:9. 24 fps.',
      'Task mode `ref2v` everywhere; continuity `shot` on segment 1 and `context` on 2-24.',
      '`ref_image_size = max`. `segment_start_number = 1`, `sampling_mode = single`.',
      '',
      '## SEGMENT 1 of 24 · shot · 00:00-00:12',
    ].join('\n'))

    expect(settings.megapixels).toBe(0.9)
    expect(settings.aspectRatio).toBe('21:9 (Ultrawide)')
    expect(settings.frameRate).toBe(24)
    expect(settings.taskMode).toBe('ref')
    expect(settings.refImageSize).toBe('max')
    expect(settings.plannedSegmentCount).toBe(24)
    expect(settings.plannedSegmentSeconds).toBe(12.25)
    expect(settings.continuity).toBe('shot')
    expect(settings.notes.some((note) => note.includes('segment_start_number = 1'))).toBe(true)
    expect(settings.notes.some((note) => note.includes('sampling_mode = single'))).toBe(true)
  })

  it('maps generator wording onto task modes', () => {
    expect(parseProjectSettings('Task mode i2v').taskMode).toBe('l2v')
    expect(parseProjectSettings('generator v2v').taskMode).toBe('edit')
    expect(parseProjectSettings('Task mode edit').taskMode).toBe('edit')
    expect(parseProjectSettings('r2v').taskMode).toBe('ref')
  })

  it('warns instead of applying an out-of-range resolution', () => {
    const settings = parseProjectSettings('resolution 32 MP, 16:9')
    expect(settings.megapixels).toBeUndefined()
    expect(settings.notes.some((note) => note.includes('was ignored'))).toBe(true)
  })

  it('does not mistake a timecode for an aspect ratio', () => {
    expect(parseProjectSettings('SEGMENT 1 · 00:08-00:16').aspectRatio).toBeUndefined()
  })

  it('uses the fps from the file as the plan frame rate', () => {
    const plan = parseLongTakeMarkdown([
      'Setup: 2 segments of 5 s, 30 fps.',
      '',
      '```',
      'first',
      '```',
      '',
      '```',
      'second',
      '```',
    ].join('\n'))
    expect(plan.frameRate).toBe(30)
    expect(plan.segments).toHaveLength(2)
    // 5 s at 30 fps is 150 frames, snapped to the nearest 17k+5 value (158).
    const project = buildImportedProject(plan)
    expect(project.frame_rate).toBe(30)
    expect(project.tracks[0].segments.map((segment) => segment.end_frame - segment.start_frame))
      .toEqual([158, 158])
  })
})

describe('buildImportedProject', () => {
  it('builds a task track from an empty project', () => {
    const plan = parseLongTakeMarkdown(guideFile([
      { mode: 'shot', start: '00:00', end: '00:08', body: 'prompt one' },
      { mode: 'context', start: '00:08', end: '00:16', body: 'prompt two' },
    ]))
    const project = buildImportedProject(plan)

    expect(project.tracks).toHaveLength(1)
    expect(project.tracks[0].type).toBe('task')
    expect(project.tracks[0].task_mode).toBe('ref')
    expect(project.total_length).toBe(384)
    expect(project.frame_rate).toBe(24)
    expect(project.tracks[0].segments.map((segment) => [segment.start_frame, segment.end_frame]))
      .toEqual([[0, 192], [192, 384]])

    const [first, second] = project.tracks[0].segments
    expect(first.content).toMatchObject({
      media_type: 'none',
      task_mode: 'ref',
      continuity_mode: 'shot',
      ref_image_size: 'max',
      user_prompt: 'prompt one',
      images: [],
    })
    expect(second.content.continuity_mode).toBe('context')
    expect(second.content.user_prompt).toBe('prompt two')
  })

  it('honours a per-segment generator mode', () => {
    const plan = parseLongTakeMarkdown([
      'Setup: 2 segments of 8 s, resolution 1 MP, 16:9. Task mode `ref`.',
      '',
      '## SEGMENT 1 of 2 · shot · task: ref2v · 00:00-00:08',
      '',
      '```',
      'first',
      '```',
      '',
      '## SEGMENT 2 of 2 · context · task: i2v · 00:08-00:16',
      '',
      '```',
      'second',
      '```',
    ].join('\n'))

    const project = buildImportedProject(plan)
    expect(project.tracks[0].segments.map((segment) => segment.content.task_mode)).toEqual(['ref', 'l2v'])
  })

  it('falls back to the setup length when headings carry no time ranges', () => {
    const plan = parseLongTakeMarkdown([
      'Setup: 2 segments of 6 s. Task mode `ref`.',
      '',
      '```',
      'first',
      '```',
      '',
      '```',
      'second',
      '```',
    ].join('\n'))

    expect(plan.totalFrames).toBe(0)
    const project = buildImportedProject(plan)
    // 6 s at 24 fps is 144 frames, snapped to the nearest 17k+5 value (141).
    expect(project.tracks[0].segments.map((segment) => segment.end_frame - segment.start_frame))
      .toEqual([141, 141])
    expect(project.total_length).toBe(282)
  })

  it('switches the resolution label it expects the editor to use', () => {
    expect(MEGAPIXEL_RESOLUTION_LABEL).toBe('width x height (megapixels)')
  })
})

describe('buildImportedTaskSegments', () => {
  it('replaces the task track with grid-legal, contiguous segments', () => {
    const plan = parseLongTakeMarkdown(guideFile([
      { mode: 'shot', start: '00:00', end: '00:08', body: 'prompt one' },
      { mode: 'context', start: '00:08', end: '00:16', body: 'prompt two' },
      { mode: 'context', start: '00:16', end: '00:24', body: 'prompt three' },
    ]))
    const built = buildImportedTaskSegments(plan, { existing: [taskSegment()], color: 'var(--primary)' })

    expect(built).toHaveLength(3)
    expect(built.map((segment) => [segment.start_frame, segment.end_frame])).toEqual([
      [0, 192],
      [192, 384],
      [384, 576],
    ])
    built.forEach((segment) => {
      expect(isH3FrameCount(segment.end_frame - segment.start_frame)).toBe(true)
    })
    expect(built.map((segment) => segment.content.continuity_mode)).toEqual(['shot', 'context', 'context'])
  })

  it('keeps the settings and references of the segment the import started from', () => {
    const plan = parseLongTakeMarkdown(guideFile([{ mode: 'shot', start: '00:00', end: '00:08', body: 'prompt one' }]))
    const built = buildImportedTaskSegments(plan, { existing: [taskSegment()], color: 'var(--primary)' })

    expect(built[0].content.task_mode).toBe('ref')
    expect(built[0].content.ref_image_size).toBe('max')
    expect(built[0].content.images?.map((image) => image.id)).toEqual(['img-1'])
    expect(built[0].content.user_prompt).toBe('prompt one')
    expect(built[0].content.media_type).toBe('none')
  })

  it('writes the B variant when the template uses it', () => {
    const plan = parseLongTakeMarkdown(guideFile([{ mode: 'shot', start: '00:00', end: '00:08', body: 'prompt one' }]))
    const built = buildImportedTaskSegments(plan, {
      existing: [taskSegment({ user_prompt_variant: 'b', user_prompt_b: 'old b' })],
      color: 'var(--primary)',
    })

    expect(built[0].content.user_prompt_b).toBe('prompt one')
    expect(built[0].content.user_prompt).toBeUndefined()
  })

  it('appends after the last existing segment without touching it', () => {
    const plan = parseLongTakeMarkdown(guideFile([{ mode: 'context', start: '00:00', end: '00:08', body: 'prompt one' }]))
    const existing = taskSegment()
    const built = buildImportedTaskSegments(plan, { existing: [existing], color: 'var(--primary)', mode: 'append' })

    expect(built).toHaveLength(2)
    expect(built[0]).toBe(existing)
    expect(built[1].start_frame).toBe(96)
    expect(built[1].end_frame).toBe(288)
    expect(built[1].content.continuity_mode).toBe('context')
  })

  it('distributes evenly when the file carries no durations', () => {
    const plan = parseLongTakeMarkdown(['## SEGMENT 1 of 2 · context', '', '```', 'a', '```', '', '## SEGMENT 2 of 2 · context', '', '```', 'b', '```'].join('\n'))
    const built = buildImportedTaskSegments(plan, {
      existing: [taskSegment()],
      color: 'var(--primary)',
      totalFrames: 720,
    })

    expect(plan.totalFrames).toBe(0)
    expect(built).toHaveLength(2)
    // 720 frames spread over two segments is 360 each, snapped to the nearest 17k+5 value.
    expect(built.map((segment) => segment.end_frame - segment.start_frame)).toEqual([362, 362])
    built.forEach((segment) => {
      expect(isH3FrameCount(segment.end_frame - segment.start_frame)).toBe(true)
    })
    expect(built[1].start_frame).toBe(built[0].end_frame)
  })

  it('returns nothing for an empty plan', () => {
    const plan = parseLongTakeMarkdown('   ')
    expect(plan.segments).toHaveLength(0)
    expect(buildImportedTaskSegments(plan, { color: 'var(--primary)' })).toEqual([])
  })
})
