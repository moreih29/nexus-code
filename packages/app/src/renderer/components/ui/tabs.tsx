import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
} from "react";
import { cn } from "../../lib/utils";

interface TabsContextValue {
  setValue: (value: string) => void;
  value: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(componentName: string): TabsContextValue {
  const context = useContext(TabsContext);

  if (!context) {
    throw new Error(`${componentName} must be used within <Tabs>.`);
  }

  return context;
}

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  defaultValue: string;
  onValueChange?: (value: string) => void;
  value?: string;
}

export function Tabs({ className, defaultValue, onValueChange, value, ...props }: TabsProps): JSX.Element {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const currentValue = value ?? internalValue;

  const contextValue = useMemo(
    () => ({
      value: currentValue,
      setValue: (nextValue: string) => {
        if (value === undefined) {
          setInternalValue(nextValue);
        }

        onValueChange?.(nextValue);
      },
    }),
    [currentValue, onValueChange, value],
  );

  return (
    <TabsContext.Provider value={contextValue}>
      <div className={cn("flex flex-col gap-3", className)} {...props} />
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "inline-flex h-10 items-center gap-1 rounded-md bg-slate-800/80 p-1 text-slate-300",
        className,
      )}
      role="tablist"
      {...props}
    />
  );
}

export interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({ className, onClick, value: triggerValue, ...props }: TabsTriggerProps): JSX.Element {
  const { setValue, value } = useTabsContext("TabsTrigger");
  const isActive = value === triggerValue;

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500",
        isActive ? "bg-slate-200 text-slate-900" : "text-slate-300 hover:bg-slate-700",
        className,
      )}
      data-state={isActive ? "active" : "inactive"}
      onClick={(event) => {
        onClick?.(event);

        if (!event.defaultPrevented) {
          setValue(triggerValue);
        }
      }}
      role="tab"
      type="button"
      {...props}
    />
  );
}

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  forceMount?: boolean;
  value: string;
}

export function TabsContent({ className, forceMount = false, value: contentValue, ...props }: TabsContentProps): JSX.Element | null {
  const { value } = useTabsContext("TabsContent");
  const isActive = value === contentValue;

  if (!forceMount && !isActive) {
    return null;
  }

  return (
    <div
      className={cn("rounded-md border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-300", className)}
      data-state={isActive ? "active" : "inactive"}
      hidden={!isActive}
      role="tabpanel"
      {...props}
    />
  );
}
