import { notFound } from "next/navigation";
import { demoJobs } from "@/lib/demo-data";

export default async function DemoApplication({
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
        maxWidth: 700,
        margin: "48px auto",
        padding: 24,
        fontFamily: "Arial, sans-serif",
      }}
    >
      <p style={{ color: "#53685f" }}>
        Controlled demo form · no employer receives this application
      </p>
      <h1>{job.title}</h1>
      <p>
        {job.company} · {job.location}
      </p>
      <form
        action="/demo/submit"
        method="post"
        encType="multipart/form-data"
        style={{ display: "grid", gap: 18, marginTop: 35 }}
      >
        <input type="hidden" name="slug" value={slug} />
        <label>
          First name
          <input name="firstName" required style={fieldStyle} />
        </label>
        <label>
          Last name
          <input name="lastName" required style={fieldStyle} />
        </label>
        <label>
          Email
          <input name="email" type="email" required style={fieldStyle} />
        </label>
        <label>
          Phone
          <input name="phone" type="tel" style={fieldStyle} />
        </label>
        <label>
          School or university
          <input name="school" style={fieldStyle} />
        </label>
        <label>
          Resume
          <input
            name="resume"
            type="file"
            accept=".pdf"
            required
            style={fieldStyle}
          />
        </label>
        {slug === "ux-researcher" && (
          <label>
            Cover letter
            <input
              name="coverLetter"
              type="file"
              accept=".pdf"
              required
              style={fieldStyle}
            />
          </label>
        )}
        <button
          type="submit"
          style={{
            background: "#173f35",
            color: "white",
            padding: 15,
            border: 0,
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Submit application
        </button>
      </form>
    </main>
  );
}
const fieldStyle = {
  display: "block",
  width: "100%",
  marginTop: 7,
  padding: 12,
  border: "1px solid #c5d0c9",
  borderRadius: 7,
};
