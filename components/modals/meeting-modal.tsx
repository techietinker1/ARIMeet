import Image from "next/image";
import type { PropsWithChildren } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type MeetingModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  className?: string;
  handleClick?: () => void;
  buttonText?: string;
  image?: string;
  buttonIcon?: string;
  isLoading?: boolean;
};

export const MeetingModal = ({
  isOpen,
  onClose,
  title,
  className,
  children,
  handleClick,
  buttonText,
  image,
  buttonIcon,
  isLoading = false,
}: PropsWithChildren<MeetingModalProps>) => {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="flex w-full max-w-[520px] flex-col gap-6 border-none bg-dark-1 px-6 py-9 text-white">
        <div className="flex flex-col gap-6">
          {image && (
            <div className="flex justify-center">
              <Image src={image} alt={title} width={72} height={72} />
            </div>
          )}

          <h1 className={cn("text-3xl font-bold leading-[42px]", className)}>
            {title}
          </h1>

          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-4 py-10">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-blue-1" />
              <p className="text-sm text-sky-2">
                Please wait while we create your meeting.
              </p>
            </div>
          ) : (
            children
          )}

          {!isLoading && (
            <Button className="bg-blue-1" onClick={handleClick}>
              {buttonIcon && (
                <Image src={buttonIcon} alt={title} width={13} height={13} />
              )}
              &nbsp;
              {buttonText || "Schedule Meeting"}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
