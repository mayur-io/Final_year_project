import { NextResponse } from "next/server";

import { getProcessJob, requestCancel, resumeProcessJob, startProcessJob, type Pipeline } from "@/lib/media/processJob";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ job: await getProcessJob(id) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await request.json() as { action?: "cancel" | "resume"; pipeline?: Pipeline; [key: string]: unknown };
    if (body.action === "cancel") return NextResponse.json({ job: await requestCancel(id) });
    if (body.action === "resume") return NextResponse.json({ job: await resumeProcessJob(id) }, { status: 202 });
    if (!body.pipeline || !["360-conversion", "frame-extraction", "image-preparation"].includes(body.pipeline)) return NextResponse.json({ error: "Unsupported processing pipeline." }, { status: 400 });
    return NextResponse.json({ job: await startProcessJob(id, body.pipeline, body as Record<string, unknown>) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not start processing." }, { status: 500 });
  }
}
