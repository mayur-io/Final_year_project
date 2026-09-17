import { InputHTMLAttributes } from "react";

export default function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-xl border border-white/10 bg-transparent px-4 py-3 outline-none placeholder:text-gray-500 focus:border-white/30"
    />
  );
}
