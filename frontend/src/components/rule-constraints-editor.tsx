"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type RuleConstraint } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

const DAYS = [
  { code: "mon", label: "Mon" },
  { code: "tue", label: "Tue" },
  { code: "wed", label: "Wed" },
  { code: "thu", label: "Thu" },
  { code: "fri", label: "Fri" },
  { code: "sat", label: "Sat" },
  { code: "sun", label: "Sun" },
];

const EMPTY_CONSTRAINT: RuleConstraint = {
  classes: [],
  days: [],
  start_time: null,
  end_time: null,
  note: "",
};

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors capitalize",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

export function RuleConstraintsEditor({ cameraId }: { cameraId: string }) {
  const [availableClasses, setAvailableClasses] = useState<string[]>([]);
  const [constraints, setConstraints] = useState<RuleConstraint[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getDetectionClasses(), api.getConstraints(cameraId)])
      .then(([classesRes, constraintsRes]) => {
        if (cancelled) return;
        setAvailableClasses(classesRes.classes);
        setConstraints(constraintsRes.constraints.length ? constraintsRes.constraints : []);
      })
      .catch((err) => toast.error((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [cameraId]);

  const updateRow = (idx: number, patch: Partial<RuleConstraint>) => {
    setConstraints((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const toggleClass = (idx: number, cls: string) => {
    setConstraints((prev) =>
      prev.map((c, i) => {
        if (i !== idx) return c;
        const has = c.classes.includes(cls);
        return { ...c, classes: has ? c.classes.filter((x) => x !== cls) : [...c.classes, cls] };
      })
    );
  };

  const toggleDay = (idx: number, day: string) => {
    setConstraints((prev) =>
      prev.map((c, i) => {
        if (i !== idx) return c;
        const has = c.days.includes(day);
        return { ...c, days: has ? c.days.filter((x) => x !== day) : [...c.days, day] };
      })
    );
  };

  const addRow = () => setConstraints((prev) => [...prev, { ...EMPTY_CONSTRAINT }]);
  const removeRow = (idx: number) => setConstraints((prev) => prev.filter((_, i) => i !== idx));

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateConstraints(cameraId, constraints);
      toast.success(`Constraints for "${cameraId}" saved.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Hard filters evaluated instantly, for example {" "}
        <span className="font-medium text-foreground">dogs</span> after{" "}
        <span className="font-medium text-foreground">4:00 PM</span>. Any row matching the event lets it through
        (leave a field empty to match anything). No rows = rely on the plain-English rule alone.
      </p>

      {constraints.map((c, idx) => (
        <div key={idx} className="flex flex-col gap-2.5 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Condition {idx + 1}</span>
            <Button variant="ghost" size="icon-sm" onClick={() => removeRow(idx)}>
              <Trash2 />
            </Button>
          </div>

          <div>
            <Label className="mb-1.5 text-xs text-muted-foreground">Objects (any of)</Label>
            <div className="flex flex-wrap gap-1.5">
              {availableClasses.map((cls) => (
                <Chip key={cls} active={c.classes.includes(cls)} onClick={() => toggleClass(idx, cls)}>
                  {cls}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-1.5 text-xs text-muted-foreground">Days</Label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d) => (
                <Chip key={d.code} active={c.days.includes(d.code)} onClick={() => toggleDay(idx, d.code)}>
                  {d.label}
                </Chip>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor={`start-${idx}`} className="mb-1.5 text-xs text-muted-foreground">From</Label>
              <Input
                id={`start-${idx}`}
                type="time"
                value={c.start_time ?? ""}
                onChange={(e) => updateRow(idx, { start_time: e.target.value || null })}
              />
            </div>
            <div>
              <Label htmlFor={`end-${idx}`} className="mb-1.5 text-xs text-muted-foreground">Until</Label>
              <Input
                id={`end-${idx}`}
                type="time"
                value={c.end_time ?? ""}
                onChange={(e) => updateRow(idx, { end_time: e.target.value || null })}
              />
            </div>
          </div>

          <div>
            <Label htmlFor={`note-${idx}`} className="mb-1.5 text-xs text-muted-foreground">
              Note to the App (optional)
            </Label>
            <Input
              id={`note-${idx}`}
              placeholder='e.g. "ignore if wearing a delivery uniform"'
              value={c.note ?? ""}
              onChange={(e) => updateRow(idx, { note: e.target.value })}
            />
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={addRow}>
          <Plus data-icon="inline-start" />
          Add Condition
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save Constraints"}
        </Button>
      </div>
    </div>
  );
}
