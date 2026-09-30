import { notFound } from "next/navigation";
import { demoJobs } from "@/lib/demo-data";

export default async function Confirmation({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const job = demoJobs.find((item) => item.sourceId === slug);
  if (!job) notFound();
  return (
    <main
      style={{
        maxWidth: 650,
        margin: "90px auto",
        padding: 30,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <p style={{ color: "#175f49" }}>Controlled demo confirmation</p>
      <h1>Application received</h1>
      <p>
        Your demo application for {job.title} at {job.company} was submitted to
        this local test form.
      </p>
      <p>No employer was contacted.</p>
    </main>
  );
}
