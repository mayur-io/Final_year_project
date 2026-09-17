"use client";

import { ReactNode } from "react";

type ModalProps = {
  title: string;
  children: ReactNode;
  onClose?: () => void;
};

export default function Modal({ title, children, onClose }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg rounded-2xl border border-white/10 bg-background p-8"
        onClick={(e) => e.stopPropagation()}
      >
        {onClose && (
          <button
            onClick={onClose}
            className="absolute right-5 top-5 text-xl text-zinc-400 transition hover:text-white"
          >
            ✕
          </button>
        )}

        <h2 className="mb-6 text-2xl font-bold">{title}</h2>

        {children}
      </div>
    </div>
  );
}
