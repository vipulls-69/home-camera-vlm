"use client";

import { useEffect, useState, type ComponentType } from "react";
import { toast } from "sonner";
import { api, type AlertConfig, type Camera, type LLMConfig, type MediaConfig } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AddCameraDialog } from "@/components/add-camera-dialog";
import { RuleConstraintsEditor } from "@/components/rule-constraints-editor";
import {
  Trash2,
  Video,
  Bell,
  MessageSquare,
  Webhook as WebhookIcon,
  Smartphone,
  Siren,
  Settings2,
  CheckCircle2,
  Sparkles,
  InfoIcon,
} from "lucide-react";

const ALL_CHANNELS = ["in_app", "slack", "webhook", "sms", "pagerduty"] as const;
type Channel = (typeof ALL_CHANNELS)[number];

const CHANNEL_COPY: Record<Channel, string> = {
  in_app: "Dashboard Alerts",
  slack: "Slack",
  webhook: "Webhook (for other apps)",
  sms: "Text Message (SMS)",
  pagerduty: "PagerDuty",
};

const CHANNEL_DESCRIPTIONS: Record<Channel, string> = {
  in_app: "Show up right here in the incident feed. Always available, nothing to set up.",
  slack: "Post alerts straight into a Slack channel via an incoming webhook.",
  webhook: "Forward the raw incident JSON to any other tool or automation you use.",
  sms: "Text your phone through Twilio when something needs your attention.",
  pagerduty: "Trigger a PagerDuty incident for your on-call rotation.",
};

const CHANNEL_ICONS: Record<Channel, ComponentType<{ className?: string }>> = {
  in_app: Bell,
  slack: MessageSquare,
  webhook: WebhookIcon,
  sms: Smartphone,
  pagerduty: Siren,
};

/** Quick-start rule templates so people don't have to write plain-English rules from scratch. */
const RULE_PRESETS = [
  {
    label: "Person after dark",
    value:
      "Alert if a person is detected after sunset or before sunrise, unless they're clearly a resident letting themselves in.",
  },
  {
    label: "Any vehicle",
    value: "Alert whenever a car, truck, or motorcycle enters the frame.",
  },
  {
    label: "Package delivery",
    value: "Alert when someone drops off or picks up a package at the door.",
  },
  {
    label: "Loitering",
    value: "Alert if a person stays in view for more than 30 seconds without entering or leaving.",
  },
];

export default function ConfigPage() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [defaultRule, setDefaultRule] = useState("");
  const [cameraRules, setCameraRules] = useState<Record<string, string>>({});
  const [alertConfig, setAlertConfig] = useState<AlertConfig | null>(null);
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [pagerdutyKeyInput, setPagerdutyKeyInput] = useState("");
  const [twilioAuthTokenInput, setTwilioAuthTokenInput] = useState("");
  const [savingAlerts, setSavingAlerts] = useState(false);
  const [activeChannelDialog, setActiveChannelDialog] = useState<Channel | null>(null);
  const [mediaConfig, setMediaConfig] = useState<MediaConfig | null>(null);
  const [savingMedia, setSavingMedia] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadAll = async () => {
      try {
        const [camerasRes, rulesRes, alertsRes, llmRes, mediaRes] = await Promise.all([
          api.listCameras(),
          api.listRules(),
          api.getAlertConfig(),
          api.getLLMConfig(),
          api.getMediaConfig(),
        ]);
        setCameras(camerasRes.cameras);
        setDefaultRule(rulesRes.default_rule);
        setCameraRules(rulesRes.camera_rules);
        setAlertConfig(alertsRes);
        setLlmConfig(llmRes);
        setMediaConfig(mediaRes);
        setLoading(false);
      } catch (err) {
        toast.error(`Failed to load configuration: ${(err as Error).message}`);
        setLoading(false);
      }
    };
    loadAll();
  }, []);

  const handleDeleteCamera = async (id: string) => {
    try {
      const res = await api.deleteCamera(id);
      setCameras(res.cameras);
      toast.success(`Camera "${id}" removed.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleSaveDefaultRule = async () => {
    try {
      await api.updateDefaultRule(defaultRule);
      toast.success("Default rule updated.");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const handleSaveRule = async (cameraId: string, rule: string) => {
    try {
      await api.updateRule(cameraId, rule);
      toast.success(`Rule for "${cameraId}" updated.`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const isChannelConfigured = (channel: Channel): boolean => {
    if (!alertConfig) return false;
    switch (channel) {
      case "in_app":
        return true;
      case "slack":
        return !!alertConfig.slack_webhook_url.trim();
      case "webhook":
        return !!alertConfig.generic_webhook_url.trim();
      case "sms":
        return !!(
          alertConfig.sms_to.trim() &&
          alertConfig.twilio_account_sid.trim() &&
          alertConfig.twilio_from_number.trim() &&
          alertConfig.has_twilio_auth_token
        );
      case "pagerduty":
        return alertConfig.has_pagerduty_key;
      default:
        return false;
    }
  };

  const validateChannelDraft = (channel: Channel): string | null => {
    if (!alertConfig) return "Configuration not loaded yet.";
    const isUrl = (v: string) => /^https?:\/\/.+/i.test(v.trim());
    switch (channel) {
      case "slack":
        if (!alertConfig.slack_webhook_url.trim()) return "Enter a Slack webhook URL.";
        if (!isUrl(alertConfig.slack_webhook_url)) return "That doesn't look like a valid webhook URL.";
        return null;
      case "webhook":
        if (!alertConfig.generic_webhook_url.trim()) return "Enter a webhook URL.";
        if (!isUrl(alertConfig.generic_webhook_url)) return "That doesn't look like a valid webhook URL.";
        return null;
      case "sms":
        if (!alertConfig.sms_to.trim()) return "Enter the phone number that should receive texts.";
        if (!alertConfig.twilio_account_sid.trim()) return "Enter your Twilio Account ID.";
        if (!alertConfig.twilio_from_number.trim()) return "Enter your Twilio sending number.";
        if (!alertConfig.has_twilio_auth_token && !twilioAuthTokenInput.trim()) return "Enter your Twilio auth token.";
        return null;
      case "pagerduty":
        if (!alertConfig.has_pagerduty_key && !pagerdutyKeyInput.trim()) return "Enter your PagerDuty routing key.";
        return null;
      default:
        return null;
    }
  };

  const persistChannels = async (channels: string[]) => {
    if (!alertConfig) return;
    setSavingAlerts(true);
    try {
      await api.updateAlertConfig({ channels, min_severity: alertConfig.min_severity });
      const refreshed = await api.getAlertConfig();
      setAlertConfig(refreshed);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingAlerts(false);
    }
  };

  const handleToggleChannel = (channel: Channel, checked: boolean) => {
    if (!alertConfig) return;
    if (checked && !isChannelConfigured(channel)) {
      // Needs first-time setup - open its dialog instead of turning on blind.
      setActiveChannelDialog(channel);
      return;
    }
    const channels = checked
      ? [...new Set([...alertConfig.channels, channel])]
      : alertConfig.channels.filter((c) => c !== channel);
    persistChannels(channels);
  };

  const setMinSeverity = (channel: string, severity: string) => {
    if (!alertConfig) return;
    setAlertConfig({
      ...alertConfig,
      min_severity: { ...alertConfig.min_severity, [channel]: severity as AlertConfig["min_severity"][string] },
    });
  };

  const handleSaveSeverityPreferences = async () => {
    if (!alertConfig) return;
    setSavingAlerts(true);
    try {
      await api.updateAlertConfig({ channels: alertConfig.channels, min_severity: alertConfig.min_severity });
      toast.success("Notification preferences saved.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingAlerts(false);
    }
  };

  const handleSaveChannelDialog = async (channel: Channel) => {
    if (!alertConfig) return;
    const error = validateChannelDraft(channel);
    if (error) {
      toast.error(error);
      return;
    }
    setSavingAlerts(true);
    try {
      const channels = [...new Set([...alertConfig.channels, channel])];
      await api.updateAlertConfig({
        channels,
        min_severity: alertConfig.min_severity,
        slack_webhook_url: alertConfig.slack_webhook_url,
        generic_webhook_url: alertConfig.generic_webhook_url,
        sms_to: alertConfig.sms_to,
        twilio_account_sid: alertConfig.twilio_account_sid,
        twilio_from_number: alertConfig.twilio_from_number,
        ...(twilioAuthTokenInput.trim() ? { twilio_auth_token: twilioAuthTokenInput.trim() } : {}),
        ...(pagerdutyKeyInput.trim() ? { pagerduty_routing_key: pagerdutyKeyInput.trim() } : {}),
      });
      const refreshed = await api.getAlertConfig();
      setAlertConfig(refreshed);
      setTwilioAuthTokenInput("");
      setPagerdutyKeyInput("");
      setActiveChannelDialog(null);
      toast.success(`${CHANNEL_COPY[channel]} connected and turned on.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingAlerts(false);
    }
  };

  const handleSaveLLMKey = async () => {
    if (!apiKeyInput.trim()) {
      toast.error("Paste your AI provider key first.");
      return;
    }
    setSavingKey(true);
    try {
      const res = await api.updateLLMConfig({ api_key: apiKeyInput.trim() });
      setLlmConfig(res);
      setApiKeyInput("");
      toast.success("Smart Detection connected and active.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingKey(false);
    }
  };

  const handleUpdateMediaConfig = async (patch: Partial<MediaConfig>) => {
    if (!mediaConfig) return;
    const next = { ...mediaConfig, ...patch };
    setMediaConfig(next);
    setSavingMedia(true);
    try {
      const res = await api.updateMediaConfig(patch);
      setMediaConfig(res);
      toast.success("Incident media settings saved.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingMedia(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 flex flex-col gap-6 sm:py-12 sm:gap-8">
        <div>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        </div>
        <div className="flex gap-2 border-b border-border pb-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-28" />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-9 w-full rounded-md" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 flex flex-col gap-6 sm:py-12 sm:gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">Settings</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          Connect cameras, tell us what to watch for, and choose how you&apos;d like to be notified.
          Changes apply right away - no restart needed.
        </p>
      </div>

      <Tabs defaultValue="cameras">
        <TabsList variant="line" className="w-full flex-wrap justify-start border-b border-border">
          <TabsTrigger value="cameras">Cameras</TabsTrigger>
          <TabsTrigger value="rules">Alert Rules</TabsTrigger>
          <TabsTrigger value="llm">App Configuration</TabsTrigger>
          <TabsTrigger value="alerts">Notifications</TabsTrigger>
        </TabsList>

        {/* --- Cameras --- */}
        <TabsContent value="cameras" className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {cameras.length} camera{cameras.length === 1 ? "" : "s"} connected
            </p>
            <AddCameraDialog onSaved={setCameras} />
          </div>

          <div className="flex flex-col gap-3">
            {cameras.map((cam) => (
              <Card key={cam.id}>
                <CardContent className="flex items-center justify-between gap-3 py-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary">
                      <Video className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{cam.id}</p>
                      <p className="text-xs text-muted-foreground truncate max-w-md">{cam.source}</p>
                    </div>
                  </div>
                  <Button variant="destructive" size="sm" onClick={() => handleDeleteCamera(cam.id)}>
                    <Trash2 data-icon="inline-start" />
                    Remove
                  </Button>
                </CardContent>
              </Card>
            ))}
            {cameras.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                  <Video className="h-8 w-8 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">No cameras connected yet</p>
                    <p className="text-xs text-muted-foreground">
                      Connect an IP camera, a spare phone, or a USB webcam to get started.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* --- Rules --- */}
        <TabsContent value="rules" className="flex flex-col gap-4">
          <Card className="border-primary/20 bg-primary/[0.03]">
            <CardContent className="flex items-start gap-3 py-4">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                <InfoIcon className="h-4 w-4 text-primary" />
              </div>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Rules are written in plain English - just describe what&apos;s worth an alert, like you would to a
                person watching the cameras. Pick a quick-start template below, then tweak the wording to fit.
                Add hard filters (time of day, specific objects) underneath for extra precision.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Default Rule</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                Applies to any camera that doesn&apos;t have a rule of its own.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {RULE_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setDefaultRule(preset.value)}
                    className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <Input value={defaultRule} onChange={(e) => setDefaultRule(e.target.value)} />
              <Button className="self-start" size="sm" onClick={handleSaveDefaultRule}>
                Save Default Rule
              </Button>
            </CardContent>
          </Card>

          {cameras.map((cam) => {
            const usingDefault = !cameraRules[cam.id]?.trim();
            return (
              <Card key={cam.id}>
                <CardHeader className="flex flex-row items-center justify-between gap-3">
                  <CardTitle className="text-sm font-medium">{cam.id}</CardTitle>
                  {usingDefault && (
                    <Badge variant="secondary" className="shrink-0">
                      Using default rule
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-col gap-3">
                    <Label className="text-xs text-muted-foreground">Plain-English Rule</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {RULE_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => setCameraRules((prev) => ({ ...prev, [cam.id]: preset.value }))}
                          className="rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <Input
                      value={cameraRules[cam.id] ?? defaultRule}
                      onChange={(e) => setCameraRules((prev) => ({ ...prev, [cam.id]: e.target.value }))}
                      placeholder='e.g. "Alert only if a person is at the front door after 10pm and is not wearing a delivery uniform."'
                    />
                    <Button
                      className="self-start"
                      size="sm"
                      onClick={() => handleSaveRule(cam.id, cameraRules[cam.id] ?? defaultRule)}
                    >
                      Save Rule
                    </Button>
                  </div>

                  <Separator />

                  <RuleConstraintsEditor cameraId={cam.id} />
                </CardContent>
              </Card>
            );
          })}
          {cameras.length === 0 && (
            <p className="text-sm text-muted-foreground">Connect a camera first to configure per-camera rules.</p>
          )}
        </TabsContent>

        {/* --- Smart Detection (VLM) --- */}
        <TabsContent value="llm" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Connect Your AI Provider</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                This powers Smart Detection - the AI that looks at what your cameras see and decides what&apos;s
                actually worth telling you about. Paste in a key from your AI provider and it&apos;ll start
                working immediately, no restart needed.
              </p>

              <div className="flex items-center gap-2 rounded-xl border border-border bg-secondary/60 px-4 py-3">
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                    llmConfig?.has_key ? "bg-primary" : "bg-destructive"
                  }`}
                />
                <span className="text-sm">
                  {llmConfig?.has_key ? (
                    <>
                      Smart Detection is on · <span className="font-mono text-muted-foreground">{llmConfig.key_preview}</span>
                    </>
                  ) : (
                    "Smart Detection is off - add a key below to turn it on."
                  )}
                </span>
              </div>

              <div>
                <Label htmlFor="llm-key" className="mb-1.5">Your AI Provider Key</Label>
                <Input
                  id="llm-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="Paste your key here"
                />
              </div>

              <Button className="self-start" onClick={handleSaveLLMKey} disabled={savingKey}>
                {savingKey ? "Connecting..." : "Connect"}
              </Button>
            </CardContent>
          </Card>

          {mediaConfig && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Save Photos & Videos of Incidents</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  When enabled, a snapshot photo and a short clip are saved for every reported incident and
                  shown alongside it in the incident feed.
                </p>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">Save incident media</span>
                  <Switch
                    checked={mediaConfig.save_media}
                    disabled={savingMedia}
                    onCheckedChange={(checked) => handleUpdateMediaConfig({ save_media: checked })}
                  />
                </div>
                <Separator />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">Save photos</span>
                  <Switch
                    checked={mediaConfig.save_photos}
                    disabled={savingMedia || !mediaConfig.save_media}
                    onCheckedChange={(checked) => handleUpdateMediaConfig({ save_photos: checked })}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm">Save video clips</span>
                  <Switch
                    checked={mediaConfig.save_videos}
                    disabled={savingMedia || !mediaConfig.save_media}
                    onCheckedChange={(checked) => handleUpdateMediaConfig({ save_videos: checked })}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* --- Notifications --- */}
        <TabsContent value="alerts" className="flex flex-col gap-4">
          {alertConfig && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium">Where should we notify you?</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-1">
                  <p className="mb-2 text-[13px] leading-relaxed text-muted-foreground">
                    Turn on a channel to start using it. The first time you turn one on, we&apos;ll ask for its
                    connection details - it only switches on once those check out.
                  </p>
                  {ALL_CHANNELS.map((channel) => {
                    const Icon = CHANNEL_ICONS[channel];
                    const enabled = alertConfig.channels.includes(channel);
                    const configured = isChannelConfigured(channel);
                    const needsSetup = channel !== "in_app";
                    return (
                      <div
                        key={channel}
                        className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{CHANNEL_COPY[channel]}</span>
                              {needsSetup && configured && (
                                <Badge variant="secondary" className="gap-1">
                                  <CheckCircle2 className="h-3 w-3" />
                                  Connected
                                </Badge>
                              )}
                            </div>
                            <p className="max-w-sm text-xs text-muted-foreground">{CHANNEL_DESCRIPTIONS[channel]}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {enabled && (
                            <Select
                              value={alertConfig.min_severity[channel] ?? "low"}
                              onValueChange={(value) => setMinSeverity(channel, value)}
                            >
                              <SelectTrigger className="w-[160px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {alertConfig.severity_levels.map((level) => (
                                  <SelectItem key={level} value={level}>
                                    {level === "low" ? "Notify on everything" : `Only if ${level}+`}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          {needsSetup && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Configure ${CHANNEL_COPY[channel]}`}
                              onClick={() => setActiveChannelDialog(channel)}
                            >
                              <Settings2 />
                            </Button>
                          )}
                          <Switch
                            checked={enabled}
                            disabled={savingAlerts}
                            onCheckedChange={(checked) => handleToggleChannel(channel, checked)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              {alertConfig.channels.length > 1 && (
                <Button onClick={handleSaveSeverityPreferences} className="self-start" disabled={savingAlerts}>
                  {savingAlerts ? "Saving..." : "Save Notification Preferences"}
                </Button>
              )}
            </>
          )}
        </TabsContent>

        {/* --- Channel setup dialog: Slack --- */}
        <Dialog open={activeChannelDialog === "slack"} onOpenChange={(open) => !open && setActiveChannelDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect Slack</DialogTitle>
              <DialogDescription>
                Paste an incoming webhook URL from your Slack workspace. We&apos;ll turn Slack alerts on as soon
                as it&apos;s saved.
              </DialogDescription>
            </DialogHeader>
            {alertConfig && (
              <div>
                <Label htmlFor="slack-url" className="mb-1.5">Slack Webhook URL</Label>
                <Input
                  id="slack-url"
                  value={alertConfig.slack_webhook_url}
                  onChange={(e) => setAlertConfig({ ...alertConfig, slack_webhook_url: e.target.value })}
                  placeholder="https://hooks.slack.com/services/..."
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setActiveChannelDialog(null)}>
                Cancel
              </Button>
              <Button onClick={() => handleSaveChannelDialog("slack")} disabled={savingAlerts}>
                {savingAlerts ? "Connecting..." : "Save & Turn On"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* --- Channel setup dialog: Webhook --- */}
        <Dialog open={activeChannelDialog === "webhook"} onOpenChange={(open) => !open && setActiveChannelDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect a Webhook</DialogTitle>
              <DialogDescription>
                We&apos;ll POST the incident JSON to this URL. Great for connecting your own automations.
              </DialogDescription>
            </DialogHeader>
            {alertConfig && (
              <div>
                <Label htmlFor="webhook-url" className="mb-1.5">Webhook URL</Label>
                <Input
                  id="webhook-url"
                  value={alertConfig.generic_webhook_url}
                  onChange={(e) => setAlertConfig({ ...alertConfig, generic_webhook_url: e.target.value })}
                  placeholder="https://example.com/webhook"
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setActiveChannelDialog(null)}>
                Cancel
              </Button>
              <Button onClick={() => handleSaveChannelDialog("webhook")} disabled={savingAlerts}>
                {savingAlerts ? "Connecting..." : "Save & Turn On"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* --- Channel setup dialog: SMS / Twilio --- */}
        <Dialog open={activeChannelDialog === "sms"} onOpenChange={(open) => !open && setActiveChannelDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect Text Messages</DialogTitle>
              <DialogDescription>
                Powered by Twilio. Fill in your account details below - alerts turn on once everything checks out.
              </DialogDescription>
            </DialogHeader>
            {alertConfig && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="twilio-sid" className="mb-1.5">Twilio Account ID</Label>
                    <Input
                      id="twilio-sid"
                      value={alertConfig.twilio_account_sid}
                      onChange={(e) => setAlertConfig({ ...alertConfig, twilio_account_sid: e.target.value })}
                      placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    />
                  </div>
                  <div>
                    <Label htmlFor="twilio-from" className="mb-1.5">Sending Number</Label>
                    <Input
                      id="twilio-from"
                      value={alertConfig.twilio_from_number}
                      onChange={(e) => setAlertConfig({ ...alertConfig, twilio_from_number: e.target.value })}
                      placeholder="+15557654321"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="sms-to" className="mb-1.5">Your Phone Number</Label>
                  <Input
                    id="sms-to"
                    value={alertConfig.sms_to}
                    onChange={(e) => setAlertConfig({ ...alertConfig, sms_to: e.target.value })}
                    placeholder="+15551234567"
                  />
                </div>
                <div>
                  <Label htmlFor="twilio-token" className="mb-1.5">Auth Token</Label>
                  <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        alertConfig.has_twilio_auth_token ? "bg-primary" : "bg-destructive"
                      }`}
                    />
                    {alertConfig.has_twilio_auth_token
                      ? `Configured: ${alertConfig.twilio_auth_token_preview}`
                      : "Not configured"}
                  </div>
                  <Input
                    id="twilio-token"
                    type="password"
                    autoComplete="off"
                    value={twilioAuthTokenInput}
                    onChange={(e) => setTwilioAuthTokenInput(e.target.value)}
                    placeholder={alertConfig.has_twilio_auth_token ? "Enter a new auth token to replace it" : "Auth token"}
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setActiveChannelDialog(null)}>
                Cancel
              </Button>
              <Button onClick={() => handleSaveChannelDialog("sms")} disabled={savingAlerts}>
                {savingAlerts ? "Connecting..." : "Save & Turn On"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* --- Channel setup dialog: PagerDuty --- */}
        <Dialog open={activeChannelDialog === "pagerduty"} onOpenChange={(open) => !open && setActiveChannelDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect PagerDuty</DialogTitle>
              <DialogDescription>
                Enter your Events API v2 routing key to trigger incidents for your on-call rotation.
              </DialogDescription>
            </DialogHeader>
            {alertConfig && (
              <div>
                <Label htmlFor="pagerduty-key" className="mb-1.5">Events API v2 Routing Key</Label>
                <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                      alertConfig.has_pagerduty_key ? "bg-primary" : "bg-destructive"
                    }`}
                  />
                  {alertConfig.has_pagerduty_key
                    ? `Configured: ${alertConfig.pagerduty_key_preview}`
                    : "Not configured"}
                </div>
                <Input
                  id="pagerduty-key"
                  type="password"
                  autoComplete="off"
                  value={pagerdutyKeyInput}
                  onChange={(e) => setPagerdutyKeyInput(e.target.value)}
                  placeholder={alertConfig.has_pagerduty_key ? "Enter a new routing key to replace it" : "Routing key"}
                />
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setActiveChannelDialog(null)}>
                Cancel
              </Button>
              <Button onClick={() => handleSaveChannelDialog("pagerduty")} disabled={savingAlerts}>
                {savingAlerts ? "Connecting..." : "Save & Turn On"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Tabs>
    </div>
  );
}
