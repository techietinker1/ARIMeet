import { MeetingList } from "@/components/meeting-list";

const PreviousPage = () => {
  return (
    <section className="flex size-full flex-col gap-10 text-white">
      <h1 className="text-3xl font-bold">Previous</h1>

      <MeetingList type="ended" />
    </section>
  );
};

export default PreviousPage;
