"use client";

import { type ChangeEvent, type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";

export type UploadMediaType = "audio" | "image" | "video";

export type UploadedFileMetadata = {
  readonly durationSeconds?: number;
  readonly height?: number;
  readonly width?: number;
};

export type UploadedFile = {
  readonly error?: string;
  readonly file: File;
  readonly id: string;
  readonly mediaType: UploadMediaType;
  readonly metadata: UploadedFileMetadata;
  readonly mimeType: string;
  readonly name: string;
  readonly previewUrl: string;
  readonly sizeBytes: number;
  readonly sizeLabel: string;
  readonly status: "error" | "reading" | "ready";
};

type UseUploadFilesOptions = {
  readonly acceptedMediaTypes?: readonly UploadMediaType[];
  readonly maxFileSizeBytes?: number;
  readonly multiple?: boolean;
  readonly requireSameMediaType?: boolean;
};

const DEFAULT_ACCEPTED_MEDIA_TYPES: readonly UploadMediaType[] = ["image", "video", "audio"];

export function useUploadFiles(options: UseUploadFilesOptions = {}) {
  const acceptedMediaTypes = options.acceptedMediaTypes ?? DEFAULT_ACCEPTED_MEDIA_TYPES;
  const multiple = options.multiple ?? true;
  const requireSameMediaType = options.requireSameMediaType ?? false;
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ownedPreviewUrls = useRef(new Set<string>());

  useEffect(() => {
    return () => {
      for (const previewUrl of ownedPreviewUrls.current) {
        revokePreviewUrl(previewUrl);
      }
      ownedPreviewUrls.current.clear();
    };
  }, []);

  const accept = acceptedMediaTypes.map((mediaType) => `${mediaType}/*`).join(",");

  function openFileDialog() {
    inputRef.current?.click();
  }

  function addFiles(fileList: FileList | readonly File[]) {
    const incomingFiles = Array.from(fileList);

    if (incomingFiles.length === 0) {
      return;
    }

    const nextErrors: string[] = [];
    const accepted: UploadedFile[] = [];
    const existingMediaType = files[0]?.mediaType;
    let nextMediaType = existingMediaType;

    for (const file of incomingFiles) {
      if (!multiple && accepted.length > 0) {
        break;
      }

      const mediaType = getFileMediaType(file);

      if (!mediaType || !acceptedMediaTypes.includes(mediaType)) {
        nextErrors.push(`${file.name} is not a supported media file.`);
        continue;
      }

      if (options.maxFileSizeBytes !== undefined && file.size > options.maxFileSizeBytes) {
        nextErrors.push(`${file.name} is larger than ${formatBytes(options.maxFileSizeBytes)}.`);
        continue;
      }

      if (requireSameMediaType) {
        nextMediaType ??= mediaType;

        if (mediaType !== nextMediaType) {
          nextErrors.push(`${file.name} is ${mediaType}; this upload only accepts ${nextMediaType} files.`);
          continue;
        }
      }

      const previewUrl = URL.createObjectURL(file);
      ownedPreviewUrls.current.add(previewUrl);

      accepted.push({
        file,
        id: crypto.randomUUID(),
        mediaType,
        metadata: {},
        mimeType: file.type,
        name: file.name,
        previewUrl,
        sizeBytes: file.size,
        sizeLabel: formatBytes(file.size),
        status: "reading",
      });
    }

    if (accepted.length > 0) {
      if (!multiple) {
        revokeOwnedFiles(files);
        setFiles(accepted);
      } else {
        setFiles((currentFiles) => [...currentFiles, ...accepted]);
      }

      for (const upload of accepted) {
        void readFileMetadata(upload).then(
          (metadata) => {
            setFiles((currentFiles) =>
              currentFiles.map((currentFile) =>
                currentFile.id === upload.id ? { ...currentFile, metadata, status: "ready" } : currentFile,
              ),
            );
          },
          () => {
            setFiles((currentFiles) =>
              currentFiles.map((currentFile) =>
                currentFile.id === upload.id
                  ? { ...currentFile, error: "Could not read media metadata.", status: "error" }
                  : currentFile,
              ),
            );
          },
        );
      }
    }

    setErrors(nextErrors);
  }

  function clearFiles() {
    revokeOwnedFiles(files);
    setFiles([]);
    setErrors([]);
  }

  function consumeFiles() {
    const consumed = files;

    for (const file of consumed) {
      ownedPreviewUrls.current.delete(file.previewUrl);
    }

    setFiles([]);
    setErrors([]);
    return consumed;
  }

  function removeFile(fileId: string) {
    setFiles((currentFiles) => {
      const removedFile = currentFiles.find((file) => file.id === fileId);

      if (removedFile) {
        revokeOwnedFiles([removedFile]);
      }

      return currentFiles.filter((file) => file.id !== fileId);
    });
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) {
      addFiles(event.currentTarget.files);
    }

    event.currentTarget.value = "";
  }

  function onDragEnter(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragging(true);
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }

    setIsDragging(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  }

  function onPaste(event: ClipboardEvent<HTMLElement>) {
    const pastedFiles = Array.from(event.clipboardData.files);

    if (pastedFiles.length === 0) {
      return;
    }

    event.preventDefault();
    addFiles(pastedFiles);
  }

  function revokeOwnedFiles(filesToRevoke: readonly UploadedFile[]) {
    for (const file of filesToRevoke) {
      revokePreviewUrl(file.previewUrl);
      ownedPreviewUrls.current.delete(file.previewUrl);
    }
  }

  return {
    accept,
    addFiles,
    clearFiles,
    consumeFiles,
    errors,
    files,
    inputRef,
    isDragging,
    multiple,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
    onInputChange,
    onPaste,
    openFileDialog,
    removeFile,
  };
}

export function getFileMediaType(file: File): UploadMediaType | null {
  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (file.type.startsWith("video/")) {
    return "video";
  }

  if (file.type.startsWith("audio/")) {
    return "audio";
  }

  return null;
}

export function formatBytes(bytes: number) {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const unit = units[exponent] ?? "B";
  const value = bytes / 1024 ** exponent;

  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function formatDuration(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function revokePreviewUrl(previewUrl: string) {
  if (previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(previewUrl);
  }
}

function readFileMetadata(file: UploadedFile): Promise<UploadedFileMetadata> {
  if (file.mediaType === "image") {
    return readImageMetadata(file.previewUrl);
  }

  if (file.mediaType === "video") {
    return readVideoMetadata(file.previewUrl);
  }

  return readAudioMetadata(file.previewUrl);
}

function readImageMetadata(previewUrl: string) {
  return new Promise<UploadedFileMetadata>((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      resolve({ height: image.naturalHeight, width: image.naturalWidth });
    };
    image.onerror = () => {
      reject(new Error("Image metadata failed to load."));
    };
    image.src = previewUrl;
  });
}

function readVideoMetadata(previewUrl: string) {
  return new Promise<UploadedFileMetadata>((resolve, reject) => {
    const video = document.createElement("video");

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({ durationSeconds: video.duration, height: video.videoHeight, width: video.videoWidth });
    };
    video.onerror = () => {
      reject(new Error("Video metadata failed to load."));
    };
    video.src = previewUrl;
    video.load();
  });
}

function readAudioMetadata(previewUrl: string) {
  return new Promise<UploadedFileMetadata>((resolve, reject) => {
    const audio = document.createElement("audio");

    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      resolve({ durationSeconds: audio.duration });
    };
    audio.onerror = () => {
      reject(new Error("Audio metadata failed to load."));
    };
    audio.src = previewUrl;
    audio.load();
  });
}
