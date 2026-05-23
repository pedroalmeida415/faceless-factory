"use client";

import { CheckIcon, CloudUploadIcon, FileAudioIcon, ImageIcon, Trash2Icon, VideoIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { formatDuration, type UploadedFile, type UploadMediaType, useUploadFiles } from "~/hooks/use-upload-files";
import { cn } from "~/lib/utils";

export type UploadFilesModalProps = {
  readonly acceptedMediaTypes?: readonly UploadMediaType[];
  readonly description?: string;
  readonly multiple?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onUpload: (files: readonly UploadedFile[]) => void;
  readonly open: boolean;
  readonly requireSameMediaType?: boolean;
  readonly title?: string;
};

export function UploadFilesModal({
  acceptedMediaTypes,
  description = "Drop files, browse from your device, or paste media from the clipboard.",
  multiple = true,
  onOpenChange,
  onUpload,
  open,
  requireSameMediaType = false,
  title = "Upload media",
}: UploadFilesModalProps) {
  const upload = useUploadFiles({ acceptedMediaTypes, multiple, requireSameMediaType });
  const readyFiles = upload.files.filter((file) => file.status === "ready");
  const pendingCount = upload.files.filter((file) => file.status === "reading").length;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      upload.clearFiles();
    }

    onOpenChange(nextOpen);
  }

  function handleUpload() {
    const files = upload.consumeFiles().filter((file) => file.status === "ready");

    if (files.length === 0) {
      return;
    }

    onUpload(files);
    onOpenChange(false);
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="pt-1" onPaste={upload.onPaste}>
          <input
            ref={upload.inputRef}
            accept={upload.accept}
            className="hidden"
            multiple={upload.multiple}
            onChange={upload.onInputChange}
            type="file"
          />
          <button
            type="button"
            className={cn(
              "block w-full rounded-xl border-2 border-border border-dashed bg-background px-6 py-8 text-center transition-colors hover:border-ring hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              upload.isDragging && "border-ring bg-muted",
            )}
            onClick={upload.openFileDialog}
            onDragEnter={upload.onDragEnter}
            onDragLeave={upload.onDragLeave}
            onDragOver={upload.onDragOver}
            onDrop={upload.onDrop}
          >
            <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <CloudUploadIcon className="size-5" />
            </span>
            <span className="mt-3 block text-sm">
              Drag and drop media here, or <span className="underline-offset-2 hover:underline">browse</span>
            </span>
            <span className="mt-1 block text-muted-foreground text-xs">
              Paste media while this dialog is open · {upload.accept || "media files"}
            </span>
          </button>

          {upload.errors.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1.5 text-destructive text-xs">
              {upload.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}

          {upload.files.length > 0 ? (
            <div className="mt-4 min-w-0">
              <div className="mb-2 flex items-center justify-between">
                <div className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
                  {readyFiles.length} of {upload.files.length} ready
                </div>
                {pendingCount > 0 ? (
                  <div className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
                    Reading {pendingCount}
                  </div>
                ) : null}
              </div>

              <ul className="flex min-w-0 flex-col gap-2.5">
                {upload.files.map((file) => (
                  <UploadFileRow key={file.id} file={file} onRemove={upload.removeFile} />
                ))}
              </ul>
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button disabled={readyFiles.length === 0} onClick={handleUpload} type="button">
            Use {multiple ? "media" : "file"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function UploadFileRow({
  file,
  onRemove,
}: {
  readonly file: UploadedFile;
  readonly onRemove: (fileId: string) => void;
}) {
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <FileGlyph mediaType={file.mediaType} />
      </div>
      <div className="min-w-0 overflow-hidden">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="block min-w-0 truncate text-sm">{file.name}</span>
          <span className="shrink-0 font-mono text-muted-foreground text-xs">{file.sizeLabel}</span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap gap-1.5 text-muted-foreground text-xs">
          <span className="block min-w-0 max-w-full truncate">{file.mimeType}</span>
          {file.metadata.width && file.metadata.height ? (
            <span>
              {file.metadata.width}x{file.metadata.height}
            </span>
          ) : null}
          {file.metadata.durationSeconds !== undefined ? (
            <span>{formatDuration(file.metadata.durationSeconds)}</span>
          ) : null}
          {file.error ? <span className="text-destructive">{file.error}</span> : null}
        </div>
      </div>
      <div className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground">
        {file.status === "ready" ? <CheckIcon className="size-3.5 text-success-foreground" /> : null}
        {file.status === "reading" ? <CloudUploadIcon className="size-3.5" /> : null}
        {file.status === "error" ? <XIcon className="size-3.5 text-destructive" /> : null}
      </div>
      <button
        type="button"
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => onRemove(file.id)}
      >
        <Trash2Icon className="size-3.5" />
        <span className="sr-only">Remove {file.name}</span>
      </button>
    </li>
  );
}

function FileGlyph({ mediaType }: { readonly mediaType: UploadMediaType }) {
  if (mediaType === "image") {
    return <ImageIcon className="size-4" />;
  }

  if (mediaType === "video") {
    return <VideoIcon className="size-4" />;
  }

  return <FileAudioIcon className="size-4" />;
}
