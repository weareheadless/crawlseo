"use client";

import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Message = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

export function AgentChat({
  taskId,
  initialMessages,
}: {
  taskId: string;
  initialMessages: Message[];
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!content.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/crawlseo/api/agent-tasks/${taskId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not send message");
      setMessages((current) => [...current, payload.message]);
      setContent("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send message");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-border/60 bg-muted/15 p-3">
        {messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">No messages yet. Ask the agent to change the implementation.</p>
        ) : messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "max-w-[90%] rounded-lg px-3 py-2 text-xs leading-5",
              message.role === "HUMAN"
                ? "ml-auto bg-primary/10 text-foreground"
                : message.role === "SYSTEM"
                  ? "bg-muted text-muted-foreground"
                  : "bg-background text-foreground",
            )}
          >
            <p className="mb-0.5 font-data text-[9px] uppercase tracking-wide text-muted-foreground">
              {message.role.toLowerCase()}
            </p>
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <form onSubmit={sendMessage} className="flex gap-2">
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={2}
          placeholder="Reply to the agent with corrections or approval notes…"
          className="min-h-[42px] flex-1 resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/55 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <Button type="submit" disabled={!content.trim() || sending}>
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Send
        </Button>
      </form>
    </div>
  );
}
