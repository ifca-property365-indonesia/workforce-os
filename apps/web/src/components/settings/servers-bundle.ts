/** One paste for the server's terminal: writes both scripts into ~/wfos-setup with quoted heredocs, then runs prepare.sh. */
export function setupBundle(files: { name: string; content: string }[], prepareCommand: string): string {
  const parts = ["mkdir -p ~/wfos-setup && cd ~/wfos-setup"];
  for (const f of files) {
    let tag = `WFOS_EOF_${f.name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    while (f.content.split("\n").includes(tag)) tag += "_";
    parts.push(`cat > ${f.name} <<'${tag}'\n${f.content.endsWith("\n") ? f.content : `${f.content}\n`}${tag}`);
  }
  parts.push(prepareCommand);
  return `${parts.join("\n")}\n`;
}
