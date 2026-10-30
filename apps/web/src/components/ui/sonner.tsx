"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

type ToasterTheme = NonNullable<ToasterProps["theme"]>

const isToasterTheme = (value: string): value is ToasterTheme =>
  value === "light" || value === "dark" || value === "system"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={isToasterTheme(theme) ? theme : "system"}
      position="bottom-right"
      closeButton
      className="toaster group [--border-radius:var(--radius)]! [--normal-bg:var(--popover)]! [--normal-border:var(--border)]! [--normal-text:var(--popover-foreground)]!"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
