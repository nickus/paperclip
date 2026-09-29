import type { RequestConfirmationInstructionsFileChangePayload } from "@paperclipai/shared";
import { cn } from "../lib/utils";

/**
 * The one instruction file write a change-consent card allows. Accepting the
 * card allows exactly this write: this file, with content whose SHA-256 is the
 * one shown (the card's diff shows the change), and nothing else.
 */
export function InstructionsFileChangeSummary({
  change,
  className,
}: {
  change: RequestConfirmationInstructionsFileChangePayload;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-2 rounded-sm bg-muted/45 px-3 py-2.5 text-sm", className)}
      data-testid="instructions-file-change"
    >
      <p className="text-xs text-muted-foreground">
        Accepting allows one write of exactly this content to this instruction file.
      </p>
      <dl className="grid gap-1">
        <div>
          <dt className="text-xs text-muted-foreground">File</dt>
          <dd className="break-all font-mono text-xs">{change.path}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">New content SHA-256</dt>
          <dd className="break-all font-mono text-xs">{change.contentSha256}</dd>
        </div>
        {change.clearLegacyPromptTemplate ? (
          <div>
            <dt className="text-xs text-muted-foreground">Also</dt>
            <dd className="font-medium text-destructive">Clears the agent&apos;s legacy prompt template</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
