"use client";
import { useState, useRef, useEffect } from "react";
import { streamChat } from "@/lib/api";
import { useAccountId } from "@/lib/account-context";
import { SendHorizonal, Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

type Message = {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
};

const EXAMPLES = [
  "Кто продал больше всего за последние 30 дней?",
  "Покажи зависшие сделки Иванова",
  "Какой win rate у команды?",
  "Где узкое место в воронке?",
];

export default function AiPage() {
  const accountId = useAccountId();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading || !accountId) return;

    setInput("");
    setLoading(true);

    const userMsg: Message = { role: "user", content };
    const assistantMsg: Message = { role: "assistant", content: "", streaming: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      let full = "";
      for await (const chunk of streamChat(accountId, content, history)) {
        full += chunk;
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: full, streaming: true };
          return next;
        });
      }
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: full, streaming: false };
        return next;
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Ошибка";
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: `❌ ${errMsg}`,
          streaming: false,
        };
        return next;
      });
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white">
        <h1 className="text-xl font-bold text-gray-900">AI Ассистент</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Задайте вопрос о продажах на естественном языке
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-6 text-center">
            <div className="w-16 h-16 bg-brand-50 rounded-2xl flex items-center justify-center">
              <Bot className="w-8 h-8 text-brand-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Чем могу помочь?</h2>
              <p className="text-sm text-gray-500 mt-1">
                Спросите о выручке, сделках, менеджерах или воронке
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => handleSend(ex)}
                  className="text-left text-sm px-4 py-3 rounded-xl border border-gray-200 hover:border-brand-300 hover:bg-brand-50 transition-colors text-gray-700"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={cn("flex gap-3", msg.role === "user" ? "justify-end" : "justify-start")}
          >
            {msg.role === "assistant" && (
              <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-4 h-4 text-brand-600" />
              </div>
            )}
            <div
              className={cn(
                "max-w-2xl rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap",
                msg.role === "user"
                  ? "bg-brand-600 text-white rounded-tr-sm"
                  : "bg-white border border-gray-200 text-gray-800 rounded-tl-sm"
              )}
            >
              {msg.content}
              {msg.streaming && (
                <span className="inline-block w-1 h-4 ml-0.5 bg-current animate-pulse rounded-sm" />
              )}
            </div>
            {msg.role === "user" && (
              <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="w-4 h-4 text-gray-600" />
              </div>
            )}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-gray-200 bg-white">
        <div className="flex gap-3 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Напишите вопрос... (Enter для отправки)"
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent min-h-[44px] max-h-32"
            style={{ overflow: "hidden" }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${el.scrollHeight}px`;
            }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="w-11 h-11 flex items-center justify-center rounded-xl bg-brand-600 hover:bg-brand-700 disabled:opacity-40 transition-colors flex-shrink-0"
          >
            <SendHorizonal className="w-4 h-4 text-white" />
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1.5">Shift+Enter — новая строка</p>
      </div>
    </div>
  );
}
