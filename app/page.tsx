"use client";

import {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Role = "user" | "assistant" | "system";
type Attachment = { id: string; name: string; dataUrl: string };
type Message = {
  id: string;
  role: Role;
  content: string;
  images?: Attachment[];
};

const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-3-5-sonnet",
  "gemini-1.5-pro",
] as const;

const LS_KEY_MODEL = "greyat.model";
const LS_KEY_HISTORY = "greyat.history";

const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB raw per image
const ACCEPT_TYPES = "image/png,image/jpeg,image/webp,image/gif";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function rolePrefix(role: Role) {
  if (role === "user") return "user@greyat:~$";
  if (role === "assistant") return "ai@greyat:~$";
  return "sys@greyat:~$";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

const GREETING_LINES = [
  "[boot] initializing GreYat_Labs terminal v0.1 ...",
  "[net]  uplink :: api.freemodel.dev/v1 :: OK",
  "[sec]  session secure // local history enabled",
  "",
  "welcome, operator.",
  "ask me anything — type below and press ⏎ to begin.",
  "tip: paste or attach images to query them.",
];
const GREETING_TEXT = GREETING_LINES.join("\n");

export default function Page() {
  const [model, setModel] = useState<(typeof MODELS)[number]>("gpt-4o-mini");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<Attachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [typedChars, setTypedChars] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // hydrate from localStorage (client-only; SSR can't access window)
  useEffect(() => {
    let m: (typeof MODELS)[number] | null = null;
    let h: Message[] | null = null;
    try {
      const rawM = localStorage.getItem(LS_KEY_MODEL);
      if (rawM && (MODELS as readonly string[]).includes(rawM)) {
        m = rawM as (typeof MODELS)[number];
      }
      const rawH = localStorage.getItem(LS_KEY_HISTORY);
      if (rawH) {
        const parsed = JSON.parse(rawH) as Message[];
        if (Array.isArray(parsed)) h = parsed;
      }
    } catch {
      // ignore corrupt storage
    }
    /* eslint-disable react-hooks/set-state-in-effect */
    if (m) setModel(m);
    if (h) setMessages(h);
    setHydrated(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(LS_KEY_MODEL, model);
    } catch {}
  }, [model, hydrated]);

  // typewriter greeting — only animates while the chat is empty
  useEffect(() => {
    if (!hydrated) return;
    if (messages.length > 0) return;
    if (typedChars >= GREETING_TEXT.length) return;
    const next = GREETING_TEXT[typedChars];
    const delay = next === "\n" ? 60 : next === " " ? 8 : 18;
    const id = window.setTimeout(() => setTypedChars((c) => c + 1), delay);
    return () => window.clearTimeout(id);
  }, [typedChars, hydrated, messages.length]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(LS_KEY_HISTORY, JSON.stringify(messages));
    } catch {
      // QuotaExceeded — base64 images can blow the ~5 MB localStorage cap.
      // Best-effort: drop history rather than crash the UI.
      try {
        localStorage.removeItem(LS_KEY_HISTORY);
      } catch {}
    }
  }, [messages, hydrated]);

  // autoscroll on new content
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  }, [input]);

  const canSend = useMemo(
    () =>
      !streaming &&
      (input.trim().length > 0 || pendingImages.length > 0),
    [streaming, input, pendingImages.length],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const clearHistory = useCallback(() => {
    if (streaming) stop();
    setMessages([]);
    setError(null);
  }, [streaming, stop]);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;

      const slotsLeft = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
      if (slotsLeft <= 0) {
        setError(`max ${MAX_IMAGES_PER_MESSAGE} images per message`);
        return;
      }

      const accepted: Attachment[] = [];
      const rejections: string[] = [];

      for (const f of arr.slice(0, slotsLeft)) {
        if (!f.type.startsWith("image/")) {
          rejections.push(`${f.name}: not an image`);
          continue;
        }
        if (f.size > MAX_IMAGE_BYTES) {
          rejections.push(
            `${f.name}: ${(f.size / 1024 / 1024).toFixed(1)}MB > 4MB limit`,
          );
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(f);
          accepted.push({
            id: uid(),
            name: f.name || "pasted-image",
            dataUrl,
          });
        } catch {
          rejections.push(`${f.name}: read failed`);
        }
      }

      if (accepted.length > 0) {
        setPendingImages((prev) => [...prev, ...accepted]);
        setError(null);
      }
      if (rejections.length > 0) {
        setError(rejections.join("; "));
      }
    },
    [pendingImages.length],
  );

  const removePending = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) void addFiles(e.target.files);
    // reset so the same file can be re-selected later
    e.target.value = "";
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f && f.type.startsWith("image/")) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const send = useCallback(
    async (text: string, images: Attachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && images.length === 0) return;

      setError(null);

      const userMsg: Message = {
        id: uid(),
        role: "user",
        content: trimmed,
        ...(images.length > 0 ? { images } : {}),
      };
      const assistantMsg: Message = {
        id: uid(),
        role: "assistant",
        content: "",
      };
      const next = [...messages, userMsg];
      setMessages([...next, assistantMsg]);
      setInput("");
      setPendingImages([]);
      setStreaming(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // serialize messages for upstream — multimodal content for any
      // message that carries images
      const wireMessages = next.map((m) => {
        if (m.role === "user" && m.images && m.images.length > 0) {
          const parts: Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          > = [];
          if (m.content) parts.push({ type: "text", text: m.content });
          for (const img of m.images) {
            parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
          }
          return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
      });

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: wireMessages }),
          signal: ctrl.signal,
        });

        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            detail = j.error || detail;
            if (j.detail) detail += ` — ${j.detail}`;
          } catch {}
          throw new Error(detail);
        }
        if (!res.body) throw new Error("Empty response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let acc = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const evt of events) {
            const lines = evt.split("\n");
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine.startsWith("data:")) continue;
              const data = trimmedLine.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const json = JSON.parse(data);
                const delta: string =
                  json?.choices?.[0]?.delta?.content ??
                  json?.choices?.[0]?.message?.content ??
                  "";
                if (delta) {
                  acc += delta;
                  setMessages((prev) => {
                    const copy = prev.slice();
                    const last = copy[copy.length - 1];
                    if (last && last.id === assistantMsg.id) {
                      copy[copy.length - 1] = { ...last, content: acc };
                    }
                    return copy;
                  });
                }
              } catch {
                // ignore keepalive / non-JSON
              }
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== "AbortError" && !/aborted/i.test(msg)) {
          setError(msg);
          setMessages((prev) => {
            const copy = prev.slice();
            const last = copy[copy.length - 1];
            if (last && last.id === assistantMsg.id && !last.content) {
              copy.pop();
            }
            return copy;
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [model, messages],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    void send(input, pendingImages);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void send(input, pendingImages);
    }
  };

  return (
    <div className="scanlines flex min-h-dvh flex-col bg-background text-foreground">
      <div className="watermark" aria-hidden />
      {/* header — minimal control bar; brand lives in the watermark */}
      <header className="relative z-10 border-b border-fg-muted/60 px-3 py-2 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
          <div className="text-[10px] text-fg-dim sm:text-xs">
            ── secure shell // ai terminal ──
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-fg-dim">
              <span>model:</span>
              <select
                value={model}
                onChange={(e) =>
                  setModel(e.target.value as (typeof MODELS)[number])
                }
                className="border border-fg-muted px-1 py-0.5 text-foreground"
                disabled={streaming}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={clearHistory}
              disabled={messages.length === 0 && !streaming}
              className="border border-danger px-2 py-0.5 text-danger transition-colors hover:bg-danger hover:text-background disabled:cursor-not-allowed disabled:border-fg-muted disabled:text-fg-muted disabled:hover:bg-transparent disabled:hover:text-fg-muted"
              title="clear chat history"
            >
              [ clear chat ]
            </button>
          </div>
        </div>
      </header>

      {/* messages */}
      <main
        ref={scrollerRef}
        className="relative z-10 flex-1 overflow-y-auto px-3 py-3 sm:px-5"
      >
        {messages.length === 0 && (
          <div className="msg-body py-4 text-fg-dim sm:py-6">
            <span className="glow text-foreground">
              {GREETING_TEXT.slice(0, typedChars)}
            </span>
            {typedChars < GREETING_TEXT.length && <span className="caret" />}
          </div>
        )}

        <ul className="flex flex-col gap-3">
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const isAssistant = m.role === "assistant";
            const showCaret = streaming && isAssistant && isLast;
            return (
              <li key={m.id} className="leading-relaxed">
                <div
                  className={
                    m.role === "user"
                      ? "text-user"
                      : m.role === "assistant"
                        ? "text-foreground"
                        : "text-fg-dim"
                  }
                >
                  <span className="text-fg-dim">{rolePrefix(m.role)}</span>{" "}
                  <span
                    className={`msg-body ${showCaret && !m.content ? "caret" : ""}`}
                  >
                    {m.content}
                    {showCaret && m.content ? (
                      <span className="caret" />
                    ) : null}
                  </span>
                </div>
                {m.images && m.images.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 pl-6">
                    {m.images.map((img) => (
                      <a
                        key={img.id}
                        href={img.dataUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-block border border-fg-muted hover:border-accent"
                        title={img.name}
                      >
                        {/* plain img: data URLs don't go through next/image */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={img.dataUrl}
                          alt={img.name}
                          className="block max-h-48 max-w-[280px] object-contain"
                        />
                      </a>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {error && (
          <div className="mt-3 border border-danger px-2 py-1 text-danger">
            ! {error}
          </div>
        )}
      </main>

      {/* input */}
      <form
        onSubmit={onSubmit}
        className="relative z-10 border-t border-fg-muted/60 px-3 py-2 sm:px-5"
      >
        {pendingImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingImages.map((p) => (
              <div
                key={p.id}
                className="relative border border-fg-muted p-1"
                title={p.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.dataUrl}
                  alt={p.name}
                  className="block h-16 w-16 object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePending(p.id)}
                  className="absolute -right-2 -top-2 border border-danger bg-background px-1 text-[10px] leading-none text-danger hover:bg-danger hover:text-background"
                  aria-label={`remove ${p.name}`}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <span className="select-none pb-2 text-fg-dim">
            user@greyat:~${" "}
          </span>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={1}
            placeholder="> message... (paste or attach images)"
            spellCheck={false}
            className="block w-full resize-none border border-fg-muted bg-transparent px-2 py-1 text-foreground placeholder:text-fg-muted"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_TYPES}
            multiple
            onChange={onFileInputChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={
              streaming || pendingImages.length >= MAX_IMAGES_PER_MESSAGE
            }
            className="border border-fg-muted px-3 py-1 text-fg-dim hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-fg-muted disabled:hover:text-fg-dim"
            title="attach image"
          >
            [+]
          </button>
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              className="border border-danger px-3 py-1 text-danger"
            >
              stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className="border border-accent px-3 py-1 text-accent disabled:cursor-not-allowed disabled:border-fg-muted disabled:text-fg-muted"
            >
              send
            </button>
          )}
        </div>
        <div className="mt-1 text-[10px] text-fg-muted sm:text-xs">
          └── api: api.freemodel.dev/v1 · history kept locally · images ≤ 4MB ·
          max {MAX_IMAGES_PER_MESSAGE}/msg
        </div>
      </form>
    </div>
  );
}
