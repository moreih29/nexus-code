import { useTranslation } from "react-i18next";
import { dateTimeFormat } from "../../utils/intl-format";

export function PeerCommitTime({ at, detailed = false }: { at: number; detailed?: boolean }) {
  const { i18n } = useTranslation();
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const format = dateTimeFormat(
    i18n.language,
    detailed ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" },
  );
  const iso = date.toISOString();
  return (
    <time dateTime={iso} title={iso}>
      {format.format(date)}
    </time>
  );
}
