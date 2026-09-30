import { notFound } from "next/navigation";
import { demoJobs } from "@/lib/demo-data";

export default async function DemoJob({
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
        maxWidth: 720,
        margin: "50px auto",
        padding: 25,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <p style={{ color: "#176249" }}>
        Illustrative demo listing · no employer posting
      </p>
      <h1>{job.title}</h1>
      <p>
        {job.company} · {job.location} · {job.employmentType}
      </p>
      <p>{job.description}</p>
      <h2>What the role asks for</h2>
      <ul>
        {job.requirements.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <a
        href={`/demo/apply/${slug}`}
        style={{
          display: "inline-block",
          background: "#0b4038",
          color: "white",
          borderRadius: 6,
          padding: "12px 19px",
          textDecoration: "none",
        }}
      >
        Open controlled application form
      </a>
    </main>
  );
}
