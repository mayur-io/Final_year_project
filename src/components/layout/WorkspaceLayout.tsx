"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode } from "react";

type Props = {
  children: ReactNode;
};

export default function WorkspaceLayout({ children }: Props) {
    const pathname = usePathname();
  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <aside className="w-64 shrink-0 border-r border-white/10 px-8 py-10">
        <h1 className="text-3xl font-bold mb-10">Splato</h1>

        <nav className="space-y-2">
          <Link
            href="/"
            className={`block w-full rounded-lg px-3 py-2 ${
              pathname === "/"
                ? "bg-white/10 text-white"
                : "text-gray-300 hover:bg-white/5 hover:text-white"
            }`}
          >
            Projects
          </Link>

          <Link
            href="/archive"
            className={`block w-full rounded-lg px-3 py-2 ${
              pathname === "/archive"
                ? "bg-white/10 text-white"
                : "text-gray-300 hover:bg-white/5 hover:text-white"
            }`}
          >
            Archive
          </Link>

          <div className="mt-8 border-t pt-6">
            <button
              disabled
              className="w-full text-left rounded-lg px-3 py-2 text-gray-400 cursor-not-allowed"
            >
              Community
              <span className="ml-2 text-xs">Coming Soon</span>
            </button>
          </div>
        </nav>
      </aside>

      <main className="flex-1 px-10 py-10">{children}</main>
    </div>
  );
}
