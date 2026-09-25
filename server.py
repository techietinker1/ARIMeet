import os
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel
import whisper

from transformers import T5ForConditionalGeneration, T5Tokenizer

app = FastAPI()

# Load Whisper model for transcription
whisper_model = whisper.load_model(
    os.getenv("WHISPER_MODEL", "base")
)  # "tiny", "base", "small", etc.

# Load local T5 model for topic-based scoring
T5_MODEL_PATH = os.path.join(os.path.dirname(__file__), "t5-base-model")
tokenizer: Optional[T5Tokenizer] = None
t5_model: Optional[T5ForConditionalGeneration] = None

if os.path.isdir(T5_MODEL_PATH):
    try:
        tokenizer = T5Tokenizer.from_pretrained(T5_MODEL_PATH)
        t5_model = T5ForConditionalGeneration.from_pretrained(T5_MODEL_PATH)
    except Exception:
        tokenizer = None
        t5_model = None


class TranscribeRequest(BaseModel):
    path: str


class ScoreRequest(BaseModel):
    topic: str
    transcript: str


class TopicRequest(BaseModel):
    topic: str


@app.post("/transcribe")
async def transcribe(req: TranscribeRequest):
    audio_path = req.path

    if not os.path.isfile(audio_path):
        return {"text": "", "error": "file_not_found"}

    # For CPU-only (no GPU) machines and typical Windows setups,
    # use fp16=False to avoid half-precision issues.
    result = whisper_model.transcribe(audio_path, fp16=False)
    text = (result.get("text") or "").strip()
    return {"text": text}


def _fallback_reference_for_topic(topic: str) -> str:
    """Fallback reference essay when T5 output is not useful.

    This does not try to be perfectly factual for every topic, but
    provides a clean, multi-sentence paragraph that stays on the
    given topic so that similarity scoring remains meaningful.
    """

    topic_clean = topic.strip()
    if not topic_clean:
        return ""

    # Simple generic template that still stays clearly on-topic.
    return (
        f"{topic_clean} is an important topic that influences many aspects of our lives. "
        f"When we think about {topic_clean.lower()}, we can consider how it affects individuals, "
        "communities, education, work and the overall quality of life. "
        f"By exploring real-life situations and practical examples related to {topic_clean.lower()}, "
        "we can better understand both the challenges and the opportunities it creates. "
        f"A thoughtful discussion of {topic_clean.lower()} should connect ideas clearly and stay focused "
        "on this theme so the main message is easy to follow."
    )


def _generate_reference_for_topic(topic: str) -> Optional[str]:
    if tokenizer is None or t5_model is None:
        # Even if T5 is not available, return a simple reference so
        # scoring can still compare the transcript against something.
        return _fallback_reference_for_topic(topic)

    # Host jo bhi topic deta hai, T5 se uska ek
    # detailed, professional explanation/essay likhwaate hain.
    # Prompt ko chhota rakhte hain taaki model sirf
    # instruction repeat na kare balki actual content likhe.
    prompt = f"Write a detailed, professional explanation of {topic}."

    inputs = tokenizer(prompt, return_tensors="pt", truncation=True, max_length=256)
    output_ids = t5_model.generate(
        **inputs,
        max_length=256,
        min_length=60,
        num_beams=4,
        early_stopping=True,
    )
    generated = tokenizer.decode(output_ids[0], skip_special_tokens=True).strip()

    # If the model mostly repeats the prompt or is very short,
    # fall back to a generic but clean reference paragraph.
    lower = generated.lower()
    if (
        not generated
        or "write a detailed, professional explanation" in lower
        or len(generated.split()) < 20
    ):
        return _fallback_reference_for_topic(topic)

    return generated


def _jaccard_similarity(a: str, b: str) -> float:
    tokens_a = {t.lower() for t in a.split() if t.strip()}
    tokens_b = {t.lower() for t in b.split() if t.strip()}
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = tokens_a.intersection(tokens_b)
    union = tokens_a.union(tokens_b)
    return len(intersection) / len(union) if union else 0.0


@app.post("/topic-description")
async def topic_description(req: TopicRequest):
    """Generate a short description paragraph from a topic using T5.

    This is used when creating a meeting: the frontend sends only the topic,
    and the backend expands it into a richer description string.
    """

    topic = req.topic.strip()
    if not topic:
        return {"error": "empty_topic"}

    reference_text = _generate_reference_for_topic(topic)
    if not reference_text:
        return {"error": "t5_model_not_loaded"}

    return {"topic": topic, "description": reference_text}


@app.post("/score")
async def score(req: ScoreRequest):
    """Score how well a transcript matches a topic.

    1. Use the local T5 model to generate a short paragraph about the topic.
    2. Compute a simple Jaccard similarity between the generated text and the transcript.
    3. Return similarity (0-1) and a score (0-100).
    """

    if not req.topic.strip() or not req.transcript.strip():
        return {"error": "empty_topic_or_transcript"}

    reference_text = _generate_reference_for_topic(req.topic)
    if not reference_text:
        return {"error": "t5_model_not_loaded"}

    similarity = _jaccard_similarity(reference_text, req.transcript)
    score = round(similarity * 100, 2)

    return {
        "topic": req.topic,
        "reference": reference_text,
        "transcript": req.transcript,
        "similarity": similarity,
        "score": score,
    }
