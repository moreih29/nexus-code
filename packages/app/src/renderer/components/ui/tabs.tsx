import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

type TabsOrientation = "horizontal" | "vertical";

interface TabsContextValue {
  orientation: TabsOrientation;
  value: string | undefined;
  setValue(value: string): void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

interface TabsProps extends Omit<React.ComponentProps<"div">, "defaultValue" | "onChange"> {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  orientation?: TabsOrientation;
}

function Tabs({
  className,
  orientation = "horizontal",
  value,
  defaultValue,
  onValueChange,
  children,
  ...props
}: TabsProps): JSX.Element {
  const [uncontrolledValue, setUncontrolledValue] = React.useState<string | undefined>(defaultValue);
  const selectedValue = value ?? uncontrolledValue;
  const setValue = React.useCallback(
    (nextValue: string) => {
      if (value === undefined) {
        setUncontrolledValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [onValueChange, value],
  );
  const contextValue = React.useMemo(
    () => ({
      orientation,
      value: selectedValue,
      setValue,
    }),
    [orientation, selectedValue, setValue],
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <div
        data-slot="tabs"
        data-orientation={orientation}
        className={cn(
          "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-[orientation=horizontal]/tabs:h-9 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof tabsListVariants>): JSX.Element {
  const context = useTabsContext("TabsList");
  return (
    <div
      data-slot="tabs-list"
      data-variant={variant}
      role="tablist"
      aria-orientation={context.orientation}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

interface TabsTriggerProps extends React.ComponentProps<"button"> {
  value: string;
}

function TabsTrigger({
  className,
  value,
  disabled,
  onClick,
  type = "button",
  ...props
}: TabsTriggerProps): JSX.Element {
  const context = useTabsContext("TabsTrigger");
  const isActive = context.value === value;

  return (
    <button
      data-slot="tabs-trigger"
      data-state={isActive ? "active" : "inactive"}
      role="tab"
      type={type}
      aria-selected={isActive}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "data-[state=active]:bg-background data-[state=active]:text-foreground dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 dark:data-[state=active]:text-foreground",
        "after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) {
          context.setValue(value);
        }
      }}
      {...props}
    />
  );
}

interface TabsContentProps extends React.ComponentProps<"div"> {
  value: string;
}

function TabsContent({
  className,
  value,
  ...props
}: TabsContentProps): JSX.Element {
  const context = useTabsContext("TabsContent");
  const isActive = context.value === value;

  return (
    <div
      data-slot="tabs-content"
      data-state={isActive ? "active" : "inactive"}
      role="tabpanel"
      hidden={!isActive}
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

function useTabsContext(componentName: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`${componentName} must be used within Tabs.`);
  }
  return context;
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
