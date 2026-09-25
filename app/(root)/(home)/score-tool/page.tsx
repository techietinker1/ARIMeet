"use client";

import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

type TranscriptRow = {
  id: string;
  studentName: string;
  userEmail?: string | null;
  meetingId: string;
  topic?: string | null;
  text: string;
  createdAt: string;
};

const ScoreToolPage = () => {
  const { toast } = useToast();

  const [topic, setTopic] = useState("");
  const [text, setText] = useState("");
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([]);
  const [isLoadingTranscripts, setIsLoadingTranscripts] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<
    | {
        reference: string;
        similarity: number;
        score: number;
      }
    | null
  >(null);

  useEffect(() => {
    const loadTranscripts = async () => {
      try {
        setIsLoadingTranscripts(true);
        const res = await fetch("/api/transcriptions");
        const data = await res.json();

        if (!res.ok || data?.success === false) {
          throw new Error(data?.message || "Failed to load transcriptions.");
        }

        const items = (data.items || []) as TranscriptRow[];
        setTranscripts(items);
      } catch (error) {
        console.error("TRANSCRIPTIONS:", error);
      } finally {
        setIsLoadingTranscripts(false);
      }
    };

    loadTranscripts();
  }, []);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".txt")) {
      toast({ title: "Please upload a .txt file.", variant: "destructive" });
      return;
    }

    try {
      const reader = new FileReader();
      reader.onload = () => {
        const content = (reader.result || "") as string;
        setText(content);
      };
      reader.readAsText(file);
    } catch (e) {
      toast({ title: "Failed to read file.", variant: "destructive" });
    }
  };

  const handleScore = async () => {
    const trimmedTopic = topic.trim();
    const trimmedText = text.trim();

    if (!trimmedTopic || !trimmedText) {
      toast({ title: "Enter topic and text first.", variant: "destructive" });
      return;
    }

    try {
      setIsLoading(true);
      setResult(null);

      const res = await fetch("/api/score-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: trimmedTopic, text: trimmedText }),
      });

      const data = await res.json();
      if (!res.ok || data?.success === false) {
        const message = data?.message || "Failed to score text.";
        throw new Error(message);
      }

      setResult({
        reference: data.reference,
        similarity: data.similarity,
        score: data.score,
      });
    } catch (error) {
      console.error("SCORE_TEXT:", error);
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Failed to score text.";
      toast({ title: message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const handleUseTranscript = (row: TranscriptRow) => {
    if (row.topic) {
      setTopic(row.topic);
    }
    setText(row.text);
    toast({ title: "Transcript loaded into Generate Score." });
  };

  const handleDownloadTranscript = (row: TranscriptRow) => {
    const raw = (row.text || "").trim();
    if (!raw) {
      toast({ title: "Transcript is empty.", variant: "destructive" });
      return;
    }

    const blob = new Blob([raw], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (row.studentName || "student").replace(/[^a-z0-9-_]/gi, "_");
    const ts = new Date(row.createdAt).toISOString().slice(0, 19).replace(/[.:T]/g, "-");
    a.href = url;
    a.download = `${safeName}_${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  };

  const handleCopyTranscript = async (row: TranscriptRow) => {
    try {
      await navigator.clipboard.writeText(row.text || "");
      toast({ title: "Transcript copied to clipboard." });
    } catch (error) {
      console.error("COPY_TRANSCRIPT:", error);
      toast({ title: "Failed to copy transcript.", variant: "destructive" });
    }
  };

  return (
    <section className="flex size-full flex-col gap-6 text-white">
      <h1 className="text-3xl font-bold">Generate Score</h1>
      <p className="text-sm text-sky-2">
        Above you can browse student transcriptions and quickly load or download
        them. Below, use the Generate Score panel to score any transcript
        against a topic using the local T5 model.
      </p>

      <div className="max-w-4xl rounded-lg bg-dark-2 p-4 text-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-white">Student Transcriptions</h2>
          {isLoadingTranscripts && (
            <span className="text-xs text-sky-2">Loading…</span>
          )}
        </div>

        {transcripts.length === 0 && !isLoadingTranscripts && (
          <p className="text-xs text-sky-2">
            No transcriptions available yet. Once meetings are recorded and
            processed by Whisper, they will appear here.
          </p>
        )}

        {transcripts.length > 0 && (
          <div className="max-h-96 overflow-auto rounded-md border border-dark-3">
            <table className="min-w-full text-left text-xs text-sky-2">
              <thead className="bg-dark-3 text-[11px] uppercase text-slate-300">
                <tr>
                  <th className="px-3 py-2 font-medium">Student</th>
                  <th className="px-3 py-2 font-medium">Topic</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {transcripts.map((row) => (
                  <tr key={row.id} className="border-t border-dark-3 align-top">
                    <td className="px-3 py-2 text-white">
                      <div className="font-medium">
                        {row.studentName}
                      </div>
                      {row.userEmail && (
                        <div className="text-[11px] text-sky-2">
                          {row.userEmail}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="max-w-xs truncate text-[11px] text-sky-2">
                        {row.topic || "—"}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-[11px]">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm" asChild={false}
                            className="h-7 px-2 text-[11px] bg-blue-1 text-white"
                            onClick={() => handleUseTranscript(row)}
                          >
                            Use in Generate Score
                          </Button>
                          <Button
                            type="button"
                            size="sm" asChild={false}
                            className="h-7 px-2 text-[11px] bg-dark-3 text-sky-2 hover:bg-dark-4"
                            onClick={() => handleCopyTranscript(row)}
                          >
                            Copy
                          </Button>
                          <Button
                            type="button"
                            size="sm" asChild={false}
                            className="h-7 px-2 text-[11px] bg-dark-3 text-sky-2 hover:bg-dark-4"
                            onClick={() => handleDownloadTranscript(row)}
                          >
                            Download
                          </Button>
                        </div>
                        <div className="max-h-20 overflow-hidden text-[11px] text-sky-2">
                          {row.text}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 max-w-2xl">
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-sky-2">Topic</span>
          <Input
            placeholder="e.g. Sachin Tendulkar"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="bg-dark-3 border-none"
          />
        </label>

        <label className="flex flex-col gap-2 text-sm">
          <span className="text-sky-2">Transcript text</span>
          <Textarea
            rows={8}
            placeholder="Paste transcript here or upload a .txt file below"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="bg-dark-3 border-none resize-y"
          />
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span className="text-sky-2">Or upload .txt file</span>
          <Input type="file" accept=".txt" onChange={handleFileChange} />
        </div>

        <Button
          type="button"
          onClick={handleScore}
          disabled={isLoading}
          className="mt-2 w-fit bg-blue-1 text-white"
        >
          {isLoading ? "Scoring..." : "Generate score"}
        </Button>
      </div>

      {result && (
        <div className="mt-6 max-w-2xl rounded-lg bg-dark-2 p-4 text-sm text-sky-2">
          <p>
            <span className="font-semibold text-white">Score:</span>{" "}
            {result.score.toFixed(1)}/100
          </p>
          <p>
            <span className="font-semibold text-white">Similarity:</span>{" "}
            {result.similarity.toFixed(3)}
          </p>
          <div className="mt-3">
            <p className="font-semibold text-white">T5 reference answer</p>
            <p className="mt-1 whitespace-pre-wrap">{result.reference}</p>
          </div>
        </div>
      )}
    </section>
  );
};

export default ScoreToolPage;
