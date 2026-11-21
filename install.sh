#!/bin/sh

fail() {
    printf 'Error: %s\n' "$1" >&2
    exit 1
}

main() {
    pi_mark=' '
    omp_mark=' '
    while :; do
        printf '%s\n' 'Install creview for:'
        printf '  [%s] 1) pi\n  [%s] 2) omp\n' "$pi_mark" "$omp_mark"
        printf '%s' 'Type 1 or 2 to toggle; press Enter on an empty line to install: '
        if ! { IFS= read -r choice < /dev/tty; } 2>/dev/null; then
            fail 'A terminal is required to choose a host. Run this installer from an interactive terminal.'
        fi
        case "$choice" in
            1) if [ "$pi_mark" = x ]; then pi_mark=' '; else pi_mark=x; fi ;;
            2) if [ "$omp_mark" = x ]; then omp_mark=' '; else omp_mark=x; fi ;;
            '') break ;;
            *) fail 'Invalid selection; nothing changed.' ;;
        esac
    done

    hosts=''
    [ "$pi_mark" != x ] || hosts=pi
    [ "$omp_mark" != x ] || hosts="${hosts:+$hosts }omp"
    [ -n "$hosts" ] || fail 'No hosts selected; nothing changed.'

    command -v git >/dev/null 2>&1 || fail 'Git is required. Install Git and try again.'
    for host in $hosts; do
        command -v "$host" >/dev/null 2>&1 || fail "$host is required. Install $host and try again."
    done
    [ -n "${HOME:-}" ] || fail 'HOME is not set.'
    destination="$HOME/.creview"
    repository='https://github.com/exphck1337/creview.git'

    if [ -e "$destination" ] || [ -L "$destination" ]; then
        [ -d "$destination" ] || fail "$destination already exists and is not a creview clone."
        prefix=$(git -C "$destination" rev-parse --show-prefix) || fail "$destination is not a Git working tree."
        [ -z "$prefix" ] || fail "$destination is not the root of a Git working tree."
        origin=$(git -C "$destination" remote get-url origin) || fail "$destination has no readable origin remote."
        case "$origin" in
            https://github.com/exphck1337/creview|https://github.com/exphck1337/creview.git|git@github.com:exphck1337/creview|git@github.com:exphck1337/creview.git|ssh://git@github.com/exphck1337/creview|ssh://git@github.com/exphck1337/creview.git) ;;
            *) fail "$destination belongs to another repository; nothing changed." ;;
        esac
        branch=$(git -C "$destination" symbolic-ref --quiet HEAD) || fail "$destination must be checked out on branch main."
        [ "$branch" = refs/heads/main ] || fail "$destination must be checked out on branch main."
        changes=$(git -C "$destination" status --porcelain --untracked-files=no) || fail "Could not check for tracked changes in $destination."
        [ -z "$changes" ] || fail "$destination has tracked changes; commit or set them aside before updating."
        head=$(git -C "$destination" rev-parse --verify 'HEAD^{commit}') || fail "Could not read HEAD in $destination."
        prior=$(git -C "$destination" rev-parse --verify 'refs/remotes/origin/main^{commit}') || fail "Could not read origin/main in $destination."

        # Do not move origin/main until the checkout has safely accepted the fetched commit.
        git -C "$destination" fetch --no-tags --refmap= origin refs/heads/main || fail 'Git fetch failed; no hosts were registered.'
        target=$(git -C "$destination" rev-parse --verify 'FETCH_HEAD^{commit}') || fail "Could not read the fetched main commit in $destination."
        if [ "$head" != "$target" ]; then
            if [ "$head" != "$prior" ]; then
                git -C "$destination" merge-base --is-ancestor "$head" "$target" || case "$?" in
                    1) fail "$destination has local commits not on the fetched main; refusing to update." ;;
                    *) fail "Could not check main ancestry in $destination." ;;
                esac
            fi
            git -C "$destination" checkout --no-overwrite-ignore -B main "$target" || fail 'Git checkout failed; no hosts were registered.'
        fi
        if [ "$prior" != "$target" ]; then
            git -C "$destination" update-ref refs/remotes/origin/main "$target" "$prior" || fail 'Could not update origin/main; no hosts were registered.'
        fi
        if [ "$head" != "$target" ]; then
            printf 'Updated creview in %s.\n' "$destination"
        else
            printf 'creview is already up to date in %s.\n' "$destination"
        fi
    else
        git clone --branch main "$repository" "$destination" || fail 'Git clone failed; no hosts were registered.'
    fi

    for host in $hosts; do
        "$host" install "$destination" || fail "$host registration failed; installation stopped."
        printf 'Registered creview with %s.\n' "$host"
    done
    printf 'Restart the selected hosts (%s), then run /creview-config to configure creview.\n' "$hosts"
}

main
