import type { Profile, ResumeDocument, ResumeEntry, ResumeField } from "@/lib/types";

const escapes: Record<string, string> = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "#": "\\#", "%": "\\%", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };
export function escapeLatex(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\{}$&#%_~^]/g, (character) => escapes[character]);
}
export function resumeLatex(profile: Pick<Profile, "name" | "email" | "phone">, doc: ResumeDocument): string {
  const compact = doc.layout === "compact";
  const field = (value: ResumeField) => escapeLatex(value.text);
  const entries = (items: ResumeEntry[]) => items.map((entry) => [
    `\\entry{${field(entry.heading)}}{${field(entry.dates)}}`,
    [entry.subheading.text, entry.location.text].filter(Boolean).length ? `\\textit{${escapeLatex([entry.subheading.text, entry.location.text].filter(Boolean).join(" | "))}}\\par` : "",
    entry.bullets.length ? `\\begin{itemize}\n${entry.bullets.map((bullet) => `\\item ${field(bullet)}`).join("\n")}\n\\end{itemize}` : "",
  ].filter(Boolean).join("\n")).join("\n");
  const section = (title: string, content: string) => content ? `\\section*{${title}}\n${content}` : "";
  // Only generated macros are executable. Applicant/model strings are escaped
  // as text; links use already-validated exact HTTPS URLs.
  const links = doc.links.map((link) => `\\href{${escapeLatex(link.text)}}{\\nolinkurl{${escapeLatex(link.text)}}}`).join(" \\enspace|\\enspace ");
  return String.raw`\documentclass[11pt,letterpaper]{article}
\usepackage[margin=0.55in]{geometry}
\usepackage{fontspec}
\setmainfont{texgyretermes}[Extension=.otf,UprightFont=*-regular,BoldFont=*-bold,ItalicFont=*-italic,BoldItalicFont=*-bolditalic]
\usepackage{enumitem,titlesec}
\usepackage[hidelinks,unicode]{hyperref}
\usepackage{xurl}
\urlstyle{same}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0pt}
\setlength{\emergencystretch}{2em}
\setlist[itemize]{leftmargin=1.2em,topsep=${compact ? "1" : "3"}pt,itemsep=${compact ? "1" : "2"}pt,parsep=0pt}
\titleformat{\section}{\large\bfseries}{}{0pt}{}[\titlerule]
\titlespacing*{\section}{0pt}{${compact ? "7" : "10"}pt}{4pt}
\newcommand{\entry}[2]{\noindent\textbf{#1}\hfill #2\par\nopagebreak}
\hypersetup{pdfauthor={},pdftitle={Resume}}
\begin{document}
${compact ? "\\fontsize{10.5}{12}\\selectfont" : "\\fontsize{11}{12.5}\\selectfont"}
\raggedright
\begin{center}
{\fontsize{23}{25}\selectfont\bfseries ${escapeLatex(profile.name || "Applicant")}}\\[3pt]
${escapeLatex([profile.email, profile.phone].filter(Boolean).join(" | "))}${links ? `\\\\[2pt]\n${links}` : ""}
\end{center}
\vspace{-7pt}
${section("EDUCATION", entries(doc.education))}
${section("EXPERIENCE", entries(doc.experience))}
${section("PROJECTS", entries(doc.projects))}
${section("SKILLS", doc.skills.map((skill) => `${field(skill)}\\par`).join("\n"))}
\end{document}
`;
}
