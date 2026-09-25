import { MeetingList } from "@/components/meeting-list";

const UpcomingPage = () => {
  return (
    <section className="flex size-full flex-col gap-10 text-white">
      <h1 className="text-3xl font-bold">Upcoming</h1>

      <MeetingList type="upcoming" />
    </section>
  );
};

export default UpcomingPage;
