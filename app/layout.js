import "./globals.css";

export const metadata = {
  title: "Resume Fit Audit",
  description:
    "Audit how well a resume fits a job description, and generate tailored application docs.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
