import type { ReactNode } from "react";

export function TriggerPill({ value, template = false }: { value: string; template?: boolean }) {
  const display = value.trim() || "__trigger__";
  return <span className={`trigger-token-pill ${value.trim() ? "" : "unresolved"}`} title={template ? "Project trigger · resolves from __trigger__" : "Project trigger"}>{display}</span>;
}

export function TriggerTemplateText({ text, triggerWord }: { text: string; triggerWord: string }) {
  const parts = text.split(/(__trigger__)/gi);
  return <span className="trigger-rich-text">{parts.map((part, index): ReactNode => part.toLowerCase() === "__trigger__"
    ? <TriggerPill key={index} value={triggerWord} template />
    : <span key={index}>{part}</span>)}</span>;
}

export function TriggerBoundText({ text, triggerWord }: { text: string; triggerWord: string }) {
  const trigger = triggerWord.trim();
  if (!trigger) return <span className="trigger-rich-text">{text}</span>;
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return <span className="trigger-rich-text">{parts.map((part, index): ReactNode => part.toLowerCase() === trigger.toLowerCase()
    ? <TriggerPill key={index} value={trigger} />
    : <span key={index}>{part}</span>)}</span>;
}
