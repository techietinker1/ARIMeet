"use client";

import Image from "next/image";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { avatarImages } from "@/constants";
import { cn } from "@/lib/utils";

type MeetingCardProps = {
  title: string;
  date: string;
  icon: string;
  isPreviousMeeting?: boolean;
  buttonIcon1?: string;
  buttonText?: string;
  handleClick: () => void;
  link: string;
  buttonDisabled?: boolean;
  copyDisabled?: boolean;
  // Optional full description text shown when clicking the card.
  fullDescription?: string | null;
};

export const MeetingCard = ({
  icon,
  title,
  date,
  isPreviousMeeting,
  buttonIcon1,
  handleClick,
  link,
  buttonText,
  buttonDisabled,
  copyDisabled,
  fullDescription,
}: MeetingCardProps) => {
  const { toast } = useToast();

  return (
    <section className="flex min-h-[258px] w-full flex-col justify-between rounded-[14px] bg-dark-1 px-5 py-8 xl:max-w-[568px]">
      <Dialog>
        <article className="flex flex-col gap-5">
          <Image src={icon} alt="upcoming" width={28} height={28} />
          <div className="flex justify-between">
            <DialogTrigger asChild>
              <button
                type="button"
                className="flex flex-1 flex-col gap-2 text-left outline-none"
              >
                <h1 className="text-2xl font-bold">{title}</h1>
                <p className="text-base font-normal">{date}</p>
                {fullDescription && (
                  <span className="text-xs text-sky-3">
                    Click to view full T5 description
                  </span>
                )}
              </button>
            </DialogTrigger>
          </div>
        </article>
        {fullDescription && (
          <DialogContent className="bg-dark-2 text-sky-2">
            <DialogHeader>
              <DialogTitle className="text-white">{title}</DialogTitle>
            </DialogHeader>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
              {fullDescription}
            </p>
          </DialogContent>
        )}
      </Dialog>
      <article className={cn("relative flex justify-center", {})}>
        <div className="relative flex w-full max-sm:hidden">
          {avatarImages.map((img, index) => (
            <Image
              key={index}
              src={img}
              alt="attendees"
              width={40}
              height={40}
              className={cn("rounded-full", { absolute: index > 0 })}
              style={{ top: 0, left: index * 28 }}
            />
          ))}
          <div className="flex-center absolute left-[136px] size-10 rounded-full border-[5px] border-dark-3 bg-dark-4">
            +5
          </div>
        </div>
        {!isPreviousMeeting && (
          <div className="flex gap-2">
            <Button
              onClick={handleClick}
              disabled={buttonDisabled}
              className="rounded bg-blue-1 px-6"
            >
              {buttonIcon1 && (
                <Image src={buttonIcon1} alt="feature" width={20} height={20} />
              )}
              &nbsp; {buttonText}
            </Button>
            <Button
              onClick={() => {
                navigator.clipboard.writeText(link);
                toast({
                  title: "Link copied.",
                });
              }}
              disabled={copyDisabled}
              className="bg-dark-4 px-6"
            >
              <Image
                src="/icons/copy.svg"
                alt="feature"
                width={20}
                height={20}
              />
              &nbsp; Copy Link
            </Button>
          </div>
        )}
      </article>
    </section>
  );
};
