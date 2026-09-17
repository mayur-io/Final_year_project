import { TextareaHTMLAttributes } from "react";

export default function Textarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return (
    <textarea
      {...props}
      className="w-full rounded-xl border border-white/10 bg-transparent px-4 py-3 outline-none placeholder:text-gray-500 resize-none focus:border-white/30"
    />
  );
}
