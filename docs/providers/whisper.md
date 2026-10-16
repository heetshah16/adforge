# openai-whisper — provider reference

**Pinned:** `openai-whisper` 20250625 (MIT). It runs on our torch, so there is no extra runtime.
- `whisper.load_model("small", device="cuda")`. `small` is multilingual (~460 MB) and covers en and hi.
- `model.transcribe(audio: np.ndarray float32 @ 16 kHz mono, language="hi", word_timestamps=True, fp16=True, condition_on_previous_text=False)` → `{ text, segments: [{ words: [{ word, start, end, probability }] }] }`.
- **Word timestamps come from cross-attention DTW.** They are good to ~±50–100 ms, which is enough for word-by-word captions at 30 fps.
- **Dependencies:** `numba` (Python 3.13 is supported), `tiktoken`, `torch`.
