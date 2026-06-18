import { StartupAPIEnv } from '../StartupAPIEnv';
import { CookieManager } from '../CookieManager';
import { getUserFromSession, checkAndClearStaleSession, isAdmin, getActiveProviders } from './utils';
import { Plan } from '../billing/Plan';

export async function handleSSR(
  request: Request,
  env: StartupAPIEnv,
  url: URL,
  usersPath: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, Response.redirect(url.origin + '/', 302));
  }

  const { id: doId, sessionId: _sessionId, profile: initialProfile, credential } = user;

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);

    // Get HTML from assets
    const assetUrl = new URL(url.toString());
    assetUrl.pathname = url.pathname.replace(usersPath, '/users/');
    const assetRequest = new Request(assetUrl.toString(), request);
    assetRequest.headers.set('x-skip-worker', 'true');
    let assetResponse = await env.ASSETS.fetch(assetRequest);

    // Follow one level of redirect if needed (e.g. for canonical URLs)
    if (assetResponse.status === 301 || assetResponse.status === 302) {
      const location = assetResponse.headers.get('Location');
      if (location) {
        const followUrl = new URL(location, assetUrl.toString());
        const followRequest = new Request(followUrl.toString(), request);
        followRequest.headers.set('x-skip-worker', 'true');
        assetResponse = await env.ASSETS.fetch(followRequest);
      }
    }

    if (!assetResponse.ok) {
      return assetResponse;
    }

    let html = await assetResponse.text();

    const data: any = {
      valid: true,
      profile: { ...initialProfile },
      credential,
    };

    const image = await userStub.getImage('avatar');
    if (image) {
      const usersPathNormalized = usersPath.endsWith('/') ? usersPath : usersPath + '/';
      data.profile.picture = usersPathNormalized + 'me/avatar';
    } else {
      data.profile.picture = null;
    }

    data.is_admin = isAdmin({ id: doId, profile: data.profile, credential }, env);

    // Fetch memberships to find current account
    const memberships = await userStub.getMemberships();
    const currentMembership = memberships.find((m: any) => m.is_current) || memberships[0];

    // Fetch credentials
    const credentials = await userStub.listCredentials();

    let account = null;
    let accountMembers = null;
    if (currentMembership) {
      const accountId = env.ACCOUNT.idFromString(currentMembership.account_id);
      const accountStub = env.ACCOUNT.get(accountId);
      const accountInfo = await accountStub.getInfo();
      const billing = await accountStub.getBillingInfo();
      account = {
        ...accountInfo,
        billing,
        id: currentMembership.account_id,
        role: currentMembership.role,
      };
      // Fetch members only if it's the accounts page or if needed
      if (url.pathname.endsWith('/accounts.html') || url.pathname.endsWith('/accounts')) {
        accountMembers = await accountStub.getMembers();
      }
    }

    // Prepare SSR values
    const replacements: Record<string, string> = {
      plans_json: JSON.stringify(Plan.getAll()).replace(/"/g, '&quot;'),
      providers: getActiveProviders(env).join(','),
      profile_json: JSON.stringify(data).replace(/"/g, '&quot;'),
      credentials_json: JSON.stringify(credentials).replace(/"/g, '&quot;'),
      profile_name: data.profile.name || 'Anonymous',
      profile_id: doId,
      profile_email: data.profile.email || '',
      profile_picture: data.profile.picture || '',
      profile_picture_display: data.profile.picture ? 'display: block;' : 'display: none;',
      profile_placeholder_display: data.profile.picture ? 'display: none;' : 'display: flex;',
      profile_remove_btn_display: data.profile.picture ? 'display: flex;' : 'display: none;',
      profile_provider_label: data.profile.provider
        ? `(from ${data.profile.provider.charAt(0).toUpperCase() + data.profile.provider.slice(1)})`
        : '',
      nav_account_display: account && (account.role === 1 || data.is_admin) ? 'display: block;' : 'display: none;',
      credentials_list_html: renderCredentialsList(credentials, data.credential?.provider),
      link_credentials_html: renderLinkCredentialsList(getActiveProviders(env), url.href),
    };

    if (account) {
      replacements['account_json'] = JSON.stringify(account).replace(/"/g, '&quot;');
      replacements['account_name'] = account.name || 'Account';
      replacements['account_id'] = account.id;

      const allPlans = Plan.getAll();
      if (allPlans.length <= 1) {
        replacements['account_plan_name'] = '';
      } else {
        replacements['account_plan_name'] = account.billing?.plan_details?.name || account.billing?.state?.plan_slug || 'free';
      }

      const accountAvatar = await env.ACCOUNT.get(env.ACCOUNT.idFromString(account.id)).getImage('avatar');
      const usersPathNormalized = usersPath.endsWith('/') ? usersPath : usersPath + '/';
      const accountPicture = accountAvatar ? `${usersPathNormalized}api/me/accounts/${account.id}/avatar` : null;

      replacements['account_picture'] = accountPicture || '';
      replacements['account_picture_display'] = accountPicture ? 'display: block;' : 'display: none;';
      replacements['account_placeholder_display'] = accountPicture ? 'display: none;' : 'display: flex;';
      replacements['account_remove_btn_display'] = accountPicture ? 'display: flex;' : 'display: none;';

      const isAccountAdmin = account.role === 1 || data.is_admin;
      replacements['account_info_section_display'] = isAccountAdmin ? 'display: block;' : 'display: none;';
      replacements['account_members_section_display'] = isAccountAdmin ? 'display: block;' : 'display: none;';

      if (accountMembers) {
        replacements['account_members_json'] = JSON.stringify(accountMembers).replace(/"/g, '&quot;');
        replacements['account_members_list_html'] = renderAccountMembersList(accountMembers, doId);
      } else {
        replacements['account_members_json'] = '[]';
        replacements['account_members_list_html'] = '<p>Loading members...</p>';
      }
    } else {
      replacements['account_json'] = 'null';
      replacements['account_name'] = '';
      replacements['account_id'] = '';
      replacements['account_plan_name'] = '';
      replacements['account_picture'] = '';
      replacements['account_picture_display'] = 'display: none;';
      replacements['account_placeholder_display'] = 'display: flex;';
      replacements['account_remove_btn_display'] = 'display: none;';
      replacements['account_info_section_display'] = 'display: none;';
      replacements['account_members_section_display'] = 'display: none;';
      replacements['account_members_json'] = '[]';
      replacements['account_members_list_html'] = '';
    }

    html = renderSSR(html, replacements);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (e) {
    console.error('[handleSSR] Error:', e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : '');
    return new Response(`Error rendering page: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
}

function renderSSR(html: string, replacements: Record<string, string>): string {
  return html.replace(/\{\{ssr:([a-z0-9_]+)\}\}/g, (match, key) => {
    return replacements[key] !== undefined ? replacements[key] : match;
  });
}

function renderCredentialsList(credentials: any[], currentProvider?: string): string {
  if (!credentials || credentials.length === 0) {
    return '<p>No credentials linked.</p>';
  }

  return credentials
    .map((c) => {
      const isCurrent = c.provider === currentProvider;
      return `
      <div class="credential-item ${isCurrent ? 'active' : ''}">
        <div class="credential-info">
          <div class="provider-icon">
            ${getProviderIcon(c.provider)}
          </div>
          <div>
            <div style="font-weight: 600;">
              ${c.provider.charAt(0).toUpperCase() + c.provider.slice(1)}
              ${isCurrent ? '<span class="current-badge">logged in</span>' : ''}
            </div>
            <div style="font-size: 0.8rem; color: #666;">${c.email || c.subject_id}</div>
          </div>
        </div>
        <button class="remove-btn" onclick="removeCredential('${c.provider}')" ${isCurrent || credentials.length === 1 ? 'disabled title="' + (isCurrent ? 'Cannot remove the method you are currently logged in with' : 'Cannot remove your last login method') + '"' : ''}>
          Remove
        </button>
      </div>
    `;
    })
    .join('');
}

function getProviderIcon(provider: string): string {
  if (provider === 'google') {
    return '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>';
  } else if (provider === 'twitch') {
    return '<svg viewBox="0 0 24 24" width="24" height="24" class="twitch-icon"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" fill="currentColor"/></svg>';
  } else if (provider === 'patreon') {
    return '<svg viewBox="0 0 24 24" width="24" height="24" class="patreon-icon"><path d="M14.82 2.41c3.96 0 7.18 3.24 7.18 7.21 0 3.96-3.22 7.18-7.18 7.18-3.97 0-7.21-3.22-7.21-7.18 0-3.97 3.24-7.21 7.21-7.21M2 21.6h3.5V2.41H2V21.6z" fill="currentColor"/></svg>';
  } else if (provider === 'atproto') {
    return '<svg viewBox="0 0 24 24" width="24" height="24" class="atproto-icon"><path d="M12 10.5C10.9 8.4 8.2 6.3 6.3 6c-1.5-.2-1.8.7-1.5 2 .2 1 1.5 5 2.3 6 .9 1.2 2 1.4 3 1.2-1.7.3-3.2 1-1.2 3 .9.9 1.6.3 2.1-.6.5-1 .8-2.1 1-2.6.2.5.5 1.6 1 2.6.5.9 1.2 1.5 2.1.6 2-2 .5-2.7-1.2-3 1 .2 2.1 0 3-1.2.8-1 2.1-5 2.3-6 .3-1.3 0-2.2-1.5-2-1.9.3-4.6 2.4-5.7 4.5z" fill="#0085FF"/></svg>';
  }
  return '';
}

function renderLinkCredentialsList(providers: string[], returnUrl?: string): string {
  if (providers.length === 0) {
    return '';
  }

  const query = returnUrl ? `?return_url=${encodeURIComponent(returnUrl)}` : '';

  return providers
    .map((provider) => {
      return `
      <a href="/users/auth/${provider}${query}" class="link-account-btn ${provider}">
        ${getProviderIcon(provider).replace('width="24" height="24"', 'width="20" height="20"')}
        ${provider.charAt(0).toUpperCase() + provider.slice(1)}
      </a>
    `;
    })
    .join('');
}

function renderAccountMembersList(members: any[], currentUserId: string): string {
  if (!members || members.length === 0) {
    return '<p>No members found.</p>';
  }

  return members
    .map((m) => {
      const isSelf = m.user_id === currentUserId;
      const avatarContent = m.picture
        ? `<img src="${m.picture}" class="member-avatar" alt="${m.name}" />`
        : `<div class="member-avatar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
            </svg>
           </div>`;

      return `
      <div class="member-item">
        <div class="member-info">
          ${avatarContent}
          <div class="member-details">
            <div class="member-name" title="${m.name}${isSelf ? ' (You)' : ''}">${m.name} ${isSelf ? '(You)' : ''}</div>
            <div class="member-role">
              <select onchange="updateRole('${m.user_id}', this.value)" ${isSelf ? 'disabled title="You cannot change your own role"' : ''} class="role-select">
                <option value="0" ${m.role === 0 ? 'selected' : ''}>Member</option>
                <option value="1" ${m.role === 1 ? 'selected' : ''}>Admin</option>
              </select>
            </div>
          </div>
        </div>
        <button class="remove-btn" onclick="removeMember('${m.user_id}')" ${isSelf ? 'disabled title="You cannot remove yourself"' : ''}>
          Remove
        </button>
      </div>
    `;
    })
    .join('');
}
