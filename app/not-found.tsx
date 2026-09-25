export const dynamic = "force-dynamic";

export default function NotFound() {
  return (
    <main className="flex h-screen items-center justify-center text-white">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-sky-2">The page you are looking for does not exist.</p>
      </div>
    </main>
  );
}
