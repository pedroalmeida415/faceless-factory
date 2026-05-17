"use client";

import { MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "~/components/ui/card";
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { api } from "~/main/trpc/react";

type WorkflowListItem = {
  readonly name: string;
  readonly updatedAt: Date;
  readonly workflowId: string;
};

export default function AppPage() {
  const router = useRouter();
  const utils = api.useUtils();
  const workflowsQuery = api.workflow.listWorkflows.useQuery();
  const createWorkflowMutation = api.workflow.createWorkflow.useMutation();
  const renameWorkflowMutation = api.workflow.renameWorkflow.useMutation();
  const deleteWorkflowMutation = api.workflow.deleteWorkflow.useMutation();
  const [renamingWorkflow, setRenamingWorkflow] = useState<WorkflowListItem | null>(null);
  const [deletingWorkflow, setDeletingWorkflow] = useState<WorkflowListItem | null>(null);
  const [workflowName, setWorkflowName] = useState("");

  const workflows = workflowsQuery.data ?? [];
  const errorMessage =
    workflowsQuery.error?.message ??
    createWorkflowMutation.error?.message ??
    renameWorkflowMutation.error?.message ??
    deleteWorkflowMutation.error?.message;

  const createWorkflow = () => {
    createWorkflowMutation.mutate(
      { name: "Untitled workflow" },
      {
        onSuccess: (workflow) => {
          void utils.workflow.listWorkflows.invalidate();
          router.push(`/app/${workflow.id}`);
        },
      },
    );
  };

  const startRename = (workflow: WorkflowListItem) => {
    setRenamingWorkflow(workflow);
    setWorkflowName(workflow.name);
  };

  const submitRename = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!renamingWorkflow) {
      return;
    }

    renameWorkflowMutation.mutate(
      { name: workflowName, workflowId: renamingWorkflow.workflowId },
      {
        onSuccess: () => {
          setRenamingWorkflow(null);
          setWorkflowName("");
          void utils.workflow.listWorkflows.invalidate();
          void utils.workflow.getWorkflow.invalidate({ workflowId: renamingWorkflow.workflowId });
        },
      },
    );
  };

  const confirmDelete = () => {
    if (!deletingWorkflow) {
      return;
    }

    deleteWorkflowMutation.mutate(
      { workflowId: deletingWorkflow.workflowId },
      {
        onSuccess: () => {
          setDeletingWorkflow(null);
          void utils.workflow.listWorkflows.invalidate();
        },
      },
    );
  };

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-medium text-muted-foreground text-sm">Workspace</p>
            <h1 className="font-heading font-semibold text-3xl tracking-tight">Workflows</h1>
            <p className="mt-2 max-w-2xl text-muted-foreground text-sm">
              Create, open, rename, or delete your workflow graph blueprints.
            </p>
          </div>
          <Button loading={createWorkflowMutation.isPending} onClick={createWorkflow}>
            <PlusIcon />
            New workflow
          </Button>
        </header>

        {errorMessage && (
          <div className="rounded-lg border border-destructive/32 bg-destructive/8 px-4 py-3 text-destructive-foreground text-sm">
            {errorMessage}
          </div>
        )}

        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>Available workflows</CardFrameTitle>
            <CardFrameDescription>
              {workflows.length} saved workflow{workflows.length === 1 ? "" : "s"}
            </CardFrameDescription>
            <CardFrameAction>
              <Button
                loading={workflowsQuery.isFetching}
                onClick={() => void workflowsQuery.refetch()}
                size="sm"
                variant="outline"
              >
                Refresh
              </Button>
            </CardFrameAction>
          </CardFrameHeader>

          {workflowsQuery.isLoading ? (
            <div className="px-6 py-12 text-center text-muted-foreground text-sm">Loading workflows...</div>
          ) : workflows.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <WorkflowIcon />
                </EmptyMedia>
                <EmptyTitle>No workflows yet</EmptyTitle>
                <EmptyDescription>Start with a blank graph blueprint and build your media pipeline.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button loading={createWorkflowMutation.isPending} onClick={createWorkflow}>
                  <PlusIcon />
                  Create workflow
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Table variant="card">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-px text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((workflow) => (
                  <TableRow key={workflow.workflowId}>
                    <TableCell>
                      <Button
                        className="h-auto px-0 py-0 font-medium"
                        render={<Link href={`/app/${workflow.workflowId}`} />}
                        variant="link"
                      >
                        {workflow.name}
                      </Button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatWorkflowUpdatedAt(workflow.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Menu>
                        <MenuTrigger
                          render={<Button aria-label={`Actions for ${workflow.name}`} size="icon-sm" variant="ghost" />}
                        >
                          <MoreHorizontalIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem render={<Link href={`/app/${workflow.workflowId}`} />}>Open</MenuItem>
                          <MenuItem onClick={() => startRename(workflow)}>
                            <PencilIcon />
                            Rename
                          </MenuItem>
                          <MenuItem onClick={() => setDeletingWorkflow(workflow)} variant="destructive">
                            <Trash2Icon />
                            Delete
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardFrame>
      </div>

      <Dialog open={renamingWorkflow !== null} onOpenChange={(open) => !open && setRenamingWorkflow(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Rename workflow</DialogTitle>
            <DialogDescription>Give this workflow a name that will make it easy to find later.</DialogDescription>
          </DialogHeader>
          <form className="contents" onSubmit={submitRename}>
            <DialogPanel>
              <Input
                aria-label="Workflow name"
                autoFocus
                maxLength={120}
                onChange={(event) => setWorkflowName(event.currentTarget.value)}
                placeholder="Workflow name"
                value={workflowName}
              />
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button
                disabled={workflowName.trim().length === 0 || !renamingWorkflow}
                loading={renameWorkflowMutation.isPending}
                type="submit"
              >
                Save name
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deletingWorkflow !== null} onOpenChange={(open) => !open && setDeletingWorkflow(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {deletingWorkflow?.name ?? "this workflow"}. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <Button loading={deleteWorkflowMutation.isPending} onClick={confirmDelete} variant="destructive">
              Delete workflow
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </main>
  );
}

function formatWorkflowUpdatedAt(updatedAt: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(updatedAt);
}
