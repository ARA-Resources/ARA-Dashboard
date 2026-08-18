"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { SIDEBAR_SECTIONS, isNavHrefActive } from "@/constants/navigation";
import { SIDEBAR } from "@/constants/sidebar";
import { useSidebar } from "@/hooks/use-sidebar";
import { useNavigation } from "@/hooks/use-navigation";
import {
  SidebarExpandable,
  SidebarLink,
} from "@/components/sidebar/sidebar-tree-item";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface AppSidebarProps {
  className?: string;
  forceExpanded?: boolean;
}

export function AppSidebar({
  className,
  forceExpanded = false,
}: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, setCollapsed, setMobileOpen } = useSidebar();
  const {
    workspace,
    activeCompanyId,
    expandedSectionIds,
    expandedCompanyIds,
    expandedModuleIds,
    toggleSectionExpanded,
    toggleCompanyExpanded,
    toggleModuleExpanded,
    expandForWorkspace,
    setActiveCompanyId,
    syncFromPathname,
    goToWorkspace,
    logout,
  } = useNavigation();

  const isCollapsed = forceExpanded ? false : collapsed;

  React.useEffect(() => {
    syncFromPathname(pathname);
  }, [pathname, syncFromPathname]);

  function closeMobile() {
    setMobileOpen(false);
  }

  function ensureExpandedSidebar() {
    if (collapsed && !forceExpanded) {
      setCollapsed(false);
    }
  }

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-out",
        className
      )}
      style={{
        width: isCollapsed ? SIDEBAR.widthCollapsed : SIDEBAR.widthExpanded,
      }}
    >
      <ScrollArea className="flex-1 px-2 py-3">
        <nav className="flex flex-col gap-1" aria-label="Primary">
          {SIDEBAR_SECTIONS.map((section) => {
            const sectionExpanded = expandedSectionIds.includes(section.id);
            const sectionActive = workspace === section.workspace;

            if (section.action === "logout") {
              return (
                <SidebarLink
                  key={section.id}
                  label={section.label}
                  icon={section.icon}
                  collapsed={isCollapsed}
                  variant="destructive"
                  active={pathname.startsWith("/logout")}
                  onClick={() => {
                    logout();
                    closeMobile();
                  }}
                />
              );
            }

            if (!section.expandable) {
              return (
                <SidebarLink
                  key={section.id}
                  href={section.href}
                  label={section.label}
                  icon={section.icon}
                  collapsed={isCollapsed}
                  active={sectionActive}
                  badge={section.badge}
                  onClick={() => {
                    goToWorkspace(section.workspace);
                    closeMobile();
                  }}
                />
              );
            }

            return (
              <SidebarExpandable
                key={section.id}
                label={section.label}
                icon={section.icon}
                expanded={sectionExpanded}
                active={sectionActive}
                collapsed={isCollapsed}
                badge={section.badge}
                onToggle={() => {
                  ensureExpandedSidebar();
                  if (!sectionExpanded) {
                    // Expand the tree only — do not close the drawer until a leaf is chosen.
                    expandForWorkspace(section.workspace);
                  } else {
                    toggleSectionExpanded(section.id);
                  }
                }}
              >                {section.companies?.map((company) => {
                  const companyId = company.id.replace(/^company:/, "");
                  const companyExpanded =
                    expandedCompanyIds.includes(companyId);
                  const companyActive =
                    activeCompanyId === companyId && workspace === "company";
                  const hasModules = company.modules.length > 0;

                  if (!hasModules) {
                    return (
                      <SidebarLink
                        key={company.id}
                        href={company.href}
                        label={company.label}
                        icon={company.icon}
                        nested
                        active={
                          companyActive ||
                          pathname === company.href ||
                          pathname.startsWith(`${company.href}/`)
                        }
                        onClick={() => {
                          setActiveCompanyId(companyId);
                          expandForWorkspace("company", companyId);
                          router.push(company.href);
                          closeMobile();
                        }}
                      />
                    );
                  }

                  return (
                    <SidebarExpandable
                      key={company.id}
                      label={company.label}
                      icon={company.icon}
                      expanded={companyExpanded}
                      active={companyActive}
                      nested
                      onToggle={() => toggleCompanyExpanded(companyId)}
                    >
                      {company.modules.map((module) => {
                        const moduleKey = module.id.replace(
                          /^company:[^:]+:/,
                          ""
                        );
                        const hasChildren = Boolean(module.children?.length);
                        const moduleExpanded =
                          (expandedModuleIds ?? []).includes(moduleKey) ||
                          (expandedModuleIds ?? []).includes(module.id);
                        const siblingHrefs =
                          module.children?.map((child) => child.href) ?? [];
                        const childActive = module.children?.some((child) =>
                          isNavHrefActive(pathname, child.href, siblingHrefs)
                        );
                        const moduleActive =
                          isNavHrefActive(pathname, module.href) ||
                          Boolean(childActive);

                        if (hasChildren) {
                          return (
                            <SidebarExpandable
                              key={module.id}
                              label={module.label}
                              icon={module.icon}
                              expanded={moduleExpanded}
                              active={moduleActive}
                              deeplyNested
                              onToggle={() =>
                                toggleModuleExpanded(moduleKey)
                              }
                            >
                              {module.children?.map((child) => {
                                const active = isNavHrefActive(
                                  pathname,
                                  child.href,
                                  siblingHrefs
                                );
                                return (
                                  <SidebarLink
                                    key={child.id}
                                    href={child.href}
                                    label={child.label}
                                    icon={child.icon}
                                    deeplyNested
                                    active={active}
                                    onClick={() => {
                                      setActiveCompanyId(companyId);
                                      expandForWorkspace("company", companyId);
                                      router.push(child.href);
                                      closeMobile();
                                    }}
                                  />
                                );
                              })}
                            </SidebarExpandable>
                          );
                        }

                        return (
                          <SidebarLink
                            key={module.id}
                            href={module.href}
                            label={module.label}
                            icon={module.icon}
                            deeplyNested
                            active={moduleActive}
                            onClick={() => {
                              setActiveCompanyId(companyId);
                              expandForWorkspace("company", companyId);
                              router.push(module.href);
                              closeMobile();
                            }}
                          />
                        );
                      })}
                    </SidebarExpandable>
                  );
                })}

                {section.groups?.map((group) => {
                  const groupKey = group.id.replace(/^dataset:/, "");
                  const hasChildren = Boolean(group.children?.length);
                  const groupExpanded =
                    (expandedModuleIds ?? []).includes(groupKey) ||
                    (expandedModuleIds ?? []).includes(group.id);
                  const siblingHrefs =
                    group.children?.map((child) => child.href) ?? [];
                  const childActive = group.children?.some((child) =>
                    isNavHrefActive(pathname, child.href, siblingHrefs)
                  );
                  const groupActive =
                    isNavHrefActive(pathname, group.href, siblingHrefs) ||
                    Boolean(childActive);

                  if (hasChildren) {
                    return (
                      <SidebarExpandable
                        key={group.id}
                        label={group.label}
                        icon={group.icon}
                        expanded={groupExpanded}
                        active={groupActive}
                        nested
                        onToggle={() => toggleModuleExpanded(groupKey)}
                      >
                        {group.children?.map((child) => {
                          const active = isNavHrefActive(
                            pathname,
                            child.href,
                            siblingHrefs
                          );
                          return (
                            <SidebarLink
                              key={child.id}
                              href={child.href}
                              label={child.label}
                              icon={child.icon}
                              deeplyNested
                              active={active}
                              badge={child.badge}
                              onClick={() => {
                                expandForWorkspace(section.workspace);
                                router.push(child.href);
                                closeMobile();
                              }}
                            />
                          );
                        })}
                      </SidebarExpandable>
                    );
                  }

                  return (
                    <SidebarLink
                      key={group.id}
                      href={group.href}
                      label={group.label}
                      icon={group.icon}
                      nested
                      active={groupActive}
                      onClick={() => {
                        expandForWorkspace(section.workspace);
                        router.push(group.href);
                        closeMobile();
                      }}
                    />
                  );
                })}

                {section.children?.map((child) => {
                  const siblingHrefs =
                    section.children?.map((item) => item.href) ?? [];
                  const active = isNavHrefActive(
                    pathname,
                    child.href,
                    siblingHrefs
                  );
                  return (
                    <SidebarLink
                      key={child.id}
                      href={child.href}
                      label={child.label}
                      icon={child.icon}
                      nested
                      active={active}
                      badge={child.badge}
                      onClick={() => {
                        expandForWorkspace(section.workspace);
                        router.push(child.href);
                        closeMobile();
                      }}
                    />
                  );
                })}
              </SidebarExpandable>
            );
          })}
        </nav>
      </ScrollArea>

      <Separator />
      <div className="px-3 py-3">
        {!isCollapsed && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Add companies in{" "}
            <span className="font-medium text-foreground">
              constants/companies.ts
            </span>
          </p>
        )}
      </div>
    </aside>
  );
}
