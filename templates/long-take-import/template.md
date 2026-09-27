# Long-take import markdown — template and format reference

Copy this file, replace the content, then use **Import MD** in the multi-track editor's preview toolbar
(**Replace** to rebuild the task track, **Append** to add after the existing segments).

---

## Template

```markdown
Setup: 3 segments of 15 s, resolution 1.2 MP, 16:9, task mode `ref`.

## SEGMENT 1 of 3 · ref · 00:00–00:15

subject_definitions: <who and what is in frame, wardrobe, room, style>
summary: <one line describing this segment>
detailed_description: <the full action, staging, camera and sound for this segment>

## SEGMENT 2 of 3 · ref · 00:15–00:30

subject_definitions: <keeps the same characters, wardrobe and room>
summary: <what continues or changes>
detailed_description: <the action for this segment; it starts from the previous segment's last frames>

## SEGMENT 3 of 3 · ref · 00:30–00:45

subject_definitions: <same>
summary: <how the piece resolves>
detailed_description: <final action, camera settle, sound>
```

## What the importer reads

| Part | Meaning |
|---|---|
| `Setup:` line | Segment count, seconds per segment, resolution in megapixels, aspect ratio, task mode. The resolution is written into the editor's resolution widget. |
| `## SEGMENT n of N · <mode> · <start>–<end>` | One heading per segment, in order. The mode is normalised (`ref` / `r2v` / `ref2va` → `ref`, `l2v` / `fl2v` / `i2v` → `l2v`, `edit` / `v2v` → `edit`, `t2v` / `default` → `default`). |
| Segment body | Written into the segment's prompt. `subject_definitions` / `summary` / `detailed_description` are the three fields the editor node uses; other lines are kept as written. |

## Rules

- **Frame counts** land on the H3 grid (`17 × k + 5` at 24 fps: 124, 141, 158, … , 294, 362). Lengths that
  miss the grid are snapped to the nearest valid count.
- **Equal segments** are strongly preferred. Keep every segment inside the model's trained range and put joins
  where nothing critical happens — a continuation segment starts from the previous segment's last frames.
- **The file's fps wins** over the node's fps if the guide states one; otherwise the node's frame rate is used.
- **Everything else is preserved** on import: video, audio and subtitle tracks, mute / solo / volume,
  task markers and the overview track. `total_length` becomes the larger of the existing length and the new
  end.
- **References are not part of the markdown.** Add cast photos in the editor, on segment 1 only, then use
  *Share → Use as shared reference* so later segments inherit them.
- **Continuity mode is not part of the markdown** either: segment 1 is `shot`, every other segment is
  `context`.

See `LONG_TAKE_MARKDOWN_WRITER.md` in this folder for a system prompt that produces files in this format.
