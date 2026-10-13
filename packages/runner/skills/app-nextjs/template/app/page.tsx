import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";

// reads the database on every request: never prerendered at build time (there is no database during the build)
export const dynamic = "force-dynamic";

type Note = { id: number; text: string; created_at: Date };

async function addNote(form: FormData) {
  "use server";
  const text = String(form.get("text") ?? "").trim().slice(0, 500);
  if (!text) return;
  await sql()`INSERT INTO notes (text) VALUES (${text})`;
  revalidatePath("/");
}

export default async function Home() {
  const notes = await sql()<Note[]>`SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 50`;
  return (
    <main>
      <h1>Hello</h1>
      <p className="lead">A starter app for Workforce OS previews: one page and one table.</p>
      <form action={addNote}>
        <input name="text" placeholder="Write a note" maxLength={500} required />
        <button type="submit">Add</button>
      </form>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            {n.text} <time>{n.created_at.toISOString().slice(0, 16).replace("T", " ")}</time>
          </li>
        ))}
        {notes.length === 0 && <li className="empty">No notes yet.</li>}
      </ul>
      <footer>version {process.env.APP_VERSION?.slice(0, 7) ?? "local"}</footer>
    </main>
  );
}
