"use client";

import Image from "next/image";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Role = "user" | "assistant" | "system";
type Message = { id: string; role: Role; content: string };

const MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "claude-3-5-sonnet",
  "gemini-1.5-pro",
] as const;

const LS_KEY_MODEL = "greyat.model";
const LS_KEY_HISTORY = "greyat.history";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function rolePrefix(role: Role) {
  if (role === "user") return "user@greyat:~$";
  if (role === "assistant") return "ai@greyat:~$";
  return "sys@greyat:~$";
}

const GREETING_LINES = [
  "[boot] initializing GreYat_Labs terminal v0.1 ...",
  "[net]  uplink :: api.freemodel.dev/v1 :: OK",
  "[sec]  session secure // local history enabled",
  "",
  "welcome, operator.",
  "ask me anything — type below and press ⏎ to begin.",
];
const GREETING_TEXT = GREETING_LINES.join("\n");

export default function Page() {
  const [model, setModel] = useState<(typeof MODELS)[number]>("gpt-4o-mini");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [typedChars, setTypedChars] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
    // newlines and spaces resolve instantly so the cadence feels natural
    const delay = next === "\n" ? 60 : next === " " ? 8 : 18;
    const id = window.setTimeout(() => setTypedChars((c) => c + 1), delay);
    return () => window.clearTimeout(id);
  }, [typedChars, hydrated, messages.length]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(LS_KEY_HISTORY, JSON.stringify(messages));
    } catch {}
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
    () => !streaming && input.trim().length > 0,
    [streaming, input],
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

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      setError(null);

      const userMsg: Message = { id: uid(), role: "user", content: text };
      const assistantMsg: Message = { id: uid(), role: "assistant", content: "" };
      const next = [...messages, userMsg];
      setMessages([...next, assistantMsg]);
      setInput("");
      setStreaming(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: next.map(({ role, content }) => ({ role, content })),
          }),
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

          // SSE: split on double newline
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const evt of events) {
            const lines = evt.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
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
                // ignore parse error for non-JSON keepalive lines
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
    void send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) void send(input);
    }
  };

  return (
    <div className="scanlines flex min-h-dvh flex-col bg-background text-foreground">
      <div className="watermark" aria-hidden />
      {/* header */}
      <header className="relative z-10 border-b border-fg-muted/60 px-3 py-2 sm:px-5">
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-3">
            <Image
              src="/logo-md.png"
              alt="GreYat Labs"
              width={48}
              height={33}
              priority
              className="h-8 w-auto select-none brand-logo sm:h-9"
            />
            <span className="glow text-sm sm:text-base">
              GreYat_Labs <span className="text-fg-dim">v0.1</span>
            </span>
          </div>
          <div className="hidden text-[10px] text-fg-dim sm:block">
            ── secure shell // ai terminal ──
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs sm:text-sm">
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
              className="border border-fg-muted px-2 py-0.5 text-fg-dim hover:text-danger"
            >
              :clear
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
        <div className="flex items-end gap-2">
          <span className="select-none pb-2 text-fg-dim">
            user@greyat:~${" "}
          </span>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="> message..."
            spellCheck={false}
            className="block w-full resize-none border border-fg-muted bg-transparent px-2 py-1 text-foreground placeholder:text-fg-muted"
          />
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
          └── api: api.freemodel.dev/v1 · history kept locally
        </div>
      </form>
    </div>
  );
}
