import { ImageIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";

export function MediaListMode() {
  return (
    <Empty className="size-full px-10 py-16">
      <EmptyHeader className="max-w-none">
        <ImageIcon aria-hidden="true" className="mb-7 size-14 text-muted-foreground" />
        <EmptyTitle className="font-sans text-2xl">Media list mode</EmptyTitle>
        <EmptyDescription className="mt-3 text-xl">Media elements are coming next.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
