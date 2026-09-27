import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import AppSidebar from "../../components/AppSidebar.vue";
import Index from "../../pages/index.vue";
import Login from "../../pages/login.vue";
import Signup from "../../pages/signup.vue";
import { setAuth } from "./helpers/nuxt-stubs";

/**
 * Guards the "signup is discoverable" UX gap this branch closes:
 *   - /login  offers a reciprocal path to /signup
 *   - /signup offers a reciprocal path to /login
 *   - the landing page's primary CTAs start a logged-out visitor at /signup
 *   - a signed-in visitor is never shown a "create account" CTA
 *   - the authenticated workspace sidebar never surfaces signup/login
 */

// Default to logged-out before every test; the auth-aware cases opt in explicitly.
beforeEach(() => setAuth(false));

describe("login page", () => {
  it("links to signup so a visitor without an account can create one", () => {
    const wrapper = mount(Login);
    const signupLink = wrapper.find('a[href="/signup"]');
    expect(signupLink.exists()).toBe(true);
    expect(signupLink.text()).toContain("Create your workspace");
    expect(wrapper.text()).toContain("Don't have an account");
  });
});

describe("signup page", () => {
  it("links back to login so an existing user can sign in instead", () => {
    const wrapper = mount(Signup);
    const loginLink = wrapper.find('a[href="/login"]');
    expect(loginLink.exists()).toBe(true);
    expect(loginLink.text()).toContain("Sign in");
    expect(wrapper.text()).toContain("Already have an account");
  });
});

describe("landing page — logged out", () => {
  it("points every primary CTA at /signup with product-voice wording", () => {
    const wrapper = mount(Index);

    const ctas = wrapper.findAll("a.button-primary");
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta.attributes("href")).toBe("/signup");
    }

    expect(wrapper.find('a[href="/signup"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("Get started");
    expect(wrapper.text()).toContain("Start building");
  });
});

describe("landing page — authenticated", () => {
  it("sends primary CTAs to the workspace and never offers signup", () => {
    setAuth(true, { user: { email: "ada@example.com" }, tenant: { name: "Acme" } });
    const wrapper = mount(Index);

    const ctas = wrapper.findAll("a.button-primary");
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta.attributes("href")).toBe("/workflows");
    }

    expect(wrapper.findAll('a[href="/signup"]')).toHaveLength(0);
    expect(wrapper.text()).toContain("Open Workspace");
  });
});

describe("authenticated workspace sidebar", () => {
  it("never surfaces a signup (or login) link to a signed-in user", () => {
    setAuth(true, { user: { email: "ada@example.com" }, tenant: { name: "Acme" } });
    const wrapper = mount(AppSidebar, { props: { open: true } });

    expect(wrapper.findAll('a[href="/signup"]')).toHaveLength(0);
    expect(wrapper.findAll('a[href="/login"]')).toHaveLength(0);
  });
});
