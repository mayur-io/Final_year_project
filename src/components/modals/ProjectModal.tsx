"use client";

import { ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
};

export default function ProjectModal({ title, children }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#111111] p-8 text-white shadow-2xl">
        <h2 className="mb-8 text-3xl font-bold">{title}</h2>

        {children}
      </div>
    </div>
  );
}
