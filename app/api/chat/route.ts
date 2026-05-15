import type { NextRequest } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

const UPSTREAM = "https://api.freemodel.dev/v1/chat/completions";

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type ChatRequestBody = {
  apiKey?: string;
  model?: string;
  messages?: ChatMessage[];
  temperature?: number;
};

function bad(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return bad(400, "Invalid JSON body");
  }

  const { apiKey: bodyKey, model, messages, temperature } = body;
  const apiKey =
    (typeof bodyKey === "string" && bodyKey.trim()) ||
    process.env.FREEMODEL_API_KEY;

  if (!apiKey) {
    return bad(
      500,
      "No API key configured. Set FREEMODEL_API_KEY env var or send apiKey in body.",
    );
  }
  if (!model || typeof model !== "string") {
    return bad(400, "Missing model");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return bad(400, "Missing messages");
  }

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(typeof temperature === "number" ? { temperature } : {}),
      }),
    });
  } catch (e) {
    return bad(
      502,
      `Failed to reach upstream: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(
      JSON.stringify({
        error: `Upstream error ${upstream.status}`,
        detail: text.slice(0, 2000),
      }),
      {
        status: upstream.status || 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
