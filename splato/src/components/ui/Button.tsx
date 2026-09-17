"use client";

import { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

export default function Button({
  variant = "primary",
  className = "",
  ...props
}: Props) {
  const variants = {
    primary: "bg-foreground text-background hover:opacity-90",
    secondary: "border border-white/10 text-foreground hover:bg-white/5",
    danger: "border border-red-500/30 text-red-400 hover:bg-red-500/10",
  };

  return (
    <button
      {...props}
      className={`rounded-xl px-4 py-2 transition font-medium ${variants[variant]} ${className}`}
    />
  );
}
