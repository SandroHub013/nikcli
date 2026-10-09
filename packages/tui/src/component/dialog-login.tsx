import { DialogPrompt } from "@tui/ui/dialog-prompt"
import type { DialogContext } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { UserApi } from "@tui/util/user-api"
import { UserSession } from "@ragu/util/user-session"
import type { UserSchema } from "@ragu/util/user-schema"
export const DialogLogin = {
  async run(dialog: DialogContext, sdk: UserApi.Sdk): Promise<UserSchema.PublicUser | null> {
    return DialogLogin.runLocal(dialog, sdk)
  },

  async runLocal(dialog: DialogContext, sdk: UserApi.Sdk): Promise<UserSchema.PublicUser | null> {
    const hasUsers = (await UserApi.hasUsers(sdk)) ?? false

    if (!hasUsers) {
      // Registration flow — first user becomes admin
      const username = await DialogPrompt.show(dialog, "Create Ragu Code account — Username", {
        placeholder: "Enter a username (min 2 chars)",
      })
      if (!username || username.trim().length < 2) return null

      const email = await DialogPrompt.show(dialog, "Create Ragu Code account — Email", {
        placeholder: "Enter your email address",
      })
      if (!email || !email.includes("@")) return null

      const password = await DialogPrompt.show(dialog, "Create Ragu Code account — Password", {
        placeholder: "Enter a password (min 8 chars)",
      })
      if (!password || password.trim().length < 8) return null

      const created = await UserApi.register(sdk, {
        username: username.trim(),
        email: email.trim().toLowerCase(),
        password,
      })
      if (!created.ok) {
        await DialogPrompt.show(dialog, `Registration failed: ${created.error}. Press Enter to retry.`, {
          placeholder: "Press Enter",
        })
        return DialogLogin.runLocal(dialog, sdk)
      }
      await UserSession.save(created.data.token)
      dialog.clear()
      return created.data.user
    } else {
      // Login flow
      const email = await DialogPrompt.show(dialog, "Sign in to Ragu Code — Email", {
        placeholder: "Enter your email address",
      })
      if (!email) return null

      const password = await DialogPrompt.show(dialog, "Sign in to Ragu Code — Password", {
        placeholder: "Enter your password",
      })
      if (password === null) return null

      // One message for both an unknown email and a wrong password: the route
      // answers the same "Invalid credentials" for each, so it does not confirm
      // whether an address has an account on this machine.
      const session = await UserApi.login(sdk, { email: email.trim().toLowerCase(), password })
      if (!session.ok) {
        await DialogPrompt.show(dialog, `${session.error}. Press Enter to retry.`, {
          placeholder: "Press Enter",
        })
        return DialogLogin.runLocal(dialog, sdk)
      }

      await UserSession.save(session.data.token)
      dialog.clear()
      return session.data.user
    }
  },
}
