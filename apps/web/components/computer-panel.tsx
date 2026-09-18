"use client";

import { BOX_UPDATE_PHASE_LABELS } from "@krubot/shared";
import { BoxDesktop } from "@/components/hq/box-desktop";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * The computer: the shared box every bot works on, opened on its desktop
 * (a GNOME session over VNC). Hiding the panel leaves it running.
 */
export function ComputerPanel({ onClose }: { onClose: () => void }) {
  const { boxUpdating, boxUpdate } = useStore();

  if (boxUpdating) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>The computer is updating</DialogTitle>
            <DialogDescription>{boxUpdate ? BOX_UPDATE_PHASE_LABELS[boxUpdate.phase] : "Please wait"}. The desktop opens again when it&apos;s back; follow along under Settings.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div className="fixed inset-0 z-[70]">
      <BoxDesktop onClose={onClose} />
    </div>
  );
}
