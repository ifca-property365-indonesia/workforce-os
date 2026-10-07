import { Bot } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <Bot className="size-6" /> Workforce OS
        </div>
        <div className="space-y-4">
          <h1 className="text-4xl font-semibold leading-tight">Hire AI employees.<br />Keep humans in charge.</h1>
          <p className="max-w-md text-indigo-200">
            Named agents with roles, memory and scoped tools. Every irreversible action stops at an approval. Every step is metered and inspectable.
          </p>
          <ul className="space-y-1 text-sm text-indigo-200">
            <li>• Per-action approvals for send, publish, pay, delete</li>
            <li>• Dry runs and replay before you change instructions</li>
            <li>• Budgets, guards and a kill switch</li>
          </ul>
        </div>
        <p className="text-xs text-indigo-300">Self-hosted · Powered by the Claude Agent SDK</p>
      </div>
      <div className="flex items-center justify-center p-6">{children}</div>
    </div>
  );
}
