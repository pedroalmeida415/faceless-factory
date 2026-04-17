import { NextResponse } from "next/server";

import { saveFormFileAsAsset } from "~/lib/workflow/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	try {
		const formData = await request.formData();
		const file = formData.get("file");

		if (!(file instanceof File)) {
			return NextResponse.json(
				{ error: "Missing file upload." },
				{ status: 400 },
			);
		}

		const kind = file.type.startsWith("image/")
			? "image"
			: file.type.startsWith("video/")
				? "video"
				: null;

		if (!kind) {
			return NextResponse.json(
				{ error: "Only image and video uploads are supported." },
				{ status: 400 },
			);
		}

		const asset = await saveFormFileAsAsset({
			file,
			kind,
			source: "upload",
		});

		return NextResponse.json({ asset });
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Upload failed unexpectedly.";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
