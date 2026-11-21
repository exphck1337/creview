#!/bin/sh
# Run on Linux with util-linux script/setsid; all installer commands are disposable fakes.
set -eu
installer=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/install.sh
script_command=$(command -v script)
setsid_command=$(command -v setsid)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM
bin="$root/bin"
mkdir "$bin"
cat > "$bin/git" <<'FAKE'
#!/bin/sh
{ printf 'git'; printf '\t%s' "$@"; printf '\n'; } >> "$TEST_LOG"
case "$1" in
    clone)
        [ "$GIT_FAIL" != clone ] || exit 17
        [ "$#" -eq 5 ] && [ "$2" = --branch ] && [ "$3" = main ] &&
            [ "$4" = https://github.com/exphck1337/creview.git ] || exit 19
        /bin/mkdir "$5"
        ;;
    -C)
        case "$3" in
            rev-parse)
                case "$4:$5" in
                    --show-prefix:) [ "$GIT_FAIL" != root ] && printf '%s\n' "$GIT_PREFIX" ;;
                    '--verify:HEAD^{commit}') /bin/cat "$TEST_GIT_STATE/head" ;;
                    '--verify:refs/remotes/origin/main^{commit}') /bin/cat "$TEST_GIT_STATE/prior" ;;
                    '--verify:FETCH_HEAD^{commit}') /bin/cat "$TEST_GIT_STATE/fetched" ;;
                    *) exit 19 ;;
                esac
                ;;
            remote)
                [ "$4" = get-url ] && [ "$5" = origin ] && [ "$GIT_FAIL" != origin ] || exit 18
                printf '%s\n' "$GIT_ORIGIN"
                ;;
            symbolic-ref)
                [ "$4" = --quiet ] && [ "$5" = HEAD ] || exit 19
                [ -n "$GIT_BRANCH" ] || exit 1
                printf '%s\n' "$GIT_BRANCH"
                ;;
            status)
                [ "$4" = --porcelain ] && [ "$5" = --untracked-files=no ] || exit 19
                [ "$GIT_FAIL" != status ] || exit 17
                [ -z "$GIT_CHANGES" ] || printf '%s\n' "$GIT_CHANGES"
                ;;
            fetch)
                [ "$4" = --no-tags ] && [ "$5" = --refmap= ] && [ "$6" = origin ] &&
                    [ "$7" = refs/heads/main ] || exit 19
                [ "$GIT_FAIL" != fetch ] || exit 17
                printf '%s\n' "$GIT_TARGET" > "$TEST_GIT_STATE/fetched"
                ;;
            merge-base)
                [ "$4" = --is-ancestor ] && [ "$5" = "$(/bin/cat "$TEST_GIT_STATE/head")" ] &&
                    [ "$6" = "$(/bin/cat "$TEST_GIT_STATE/fetched")" ] || exit 19
                exit "$GIT_ANCESTOR_STATUS"
                ;;
            checkout)
                [ "$4" = --no-overwrite-ignore ] && [ "$5" = -B ] && [ "$6" = main ] &&
                    [ "$7" = "$(/bin/cat "$TEST_GIT_STATE/fetched")" ] || exit 19
                [ "$GIT_FAIL" != checkout ] || exit 17
                printf '%s\n' "$7" > "$TEST_GIT_STATE/head"
                ;;
            update-ref)
                [ "$4" = refs/remotes/origin/main ] && [ "$5" = "$(/bin/cat "$TEST_GIT_STATE/head")" ] &&
                    [ "$6" = "$(/bin/cat "$TEST_GIT_STATE/prior")" ] || exit 19
                [ "$GIT_FAIL" != update-ref ] || exit 17
                printf '%s\n' "$5" > "$TEST_GIT_STATE/prior"
                ;;
            *) exit 19 ;;
        esac
        ;;
    *) exit 19 ;;
esac
FAKE
for host in pi omp; do
    cat > "$bin/$host" <<FAKE
#!/bin/sh
printf '%s\\t%s\\t%s\\n' '$host' "\$1" "\$2" >> "\$TEST_LOG"
[ "\$#" -eq 2 ] && [ "\$1" = install ] || exit 19
[ "\$FAIL_HOST" != '$host' ] || exit 23
FAKE
done
chmod +x "$bin/git" "$bin/pi" "$bin/omp"
export INSTALLER="$installer" TEST_LOG="$root/log" SHELL=/bin/sh
export GIT_FAIL GIT_PREFIX GIT_ORIGIN GIT_BRANCH GIT_CHANGES GIT_TARGET GIT_ANCESTOR_STATUS FAIL_HOST TEST_GIT_STATE
n=0
fresh() {
    n=$((n + 1))
    export HOME="$root/home with spaces $n"
    mkdir "$HOME"
    : > "$TEST_LOG"
    GIT_FAIL='' GIT_PREFIX='' FAIL_HOST=''
    GIT_ORIGIN='https://github.com/exphck1337/creview.git'
    GIT_BRANCH=refs/heads/main GIT_CHANGES='' GIT_TARGET=published GIT_ANCESTOR_STATUS=0
    TEST_GIT_STATE="$HOME/git-state"
}
run() {
    expected=$1
    shift
    # The checklist reads this PTY; the shell's stdin is installer code, not the answers.
    if printf '%s\n' "$@" | PATH="$bin" "$script_command" -q -e -c '/bin/cat "$INSTALLER" | /bin/sh' /dev/null > "$root/output" 2>&1; then
        status=0
    else
        status=$?
    fi
    if [ "$expected" = success ]; then
        [ "$status" -eq 0 ] || { cat "$root/output"; exit 1; }
    else
        [ "$status" -ne 0 ] || { cat "$root/output"; exit 1; }
        ! grep -q 'Restart the selected hosts' "$root/output"
    fi
}
contains() { grep -Fq "$1" "$root/output"; }
no_write() { [ ! -e "$HOME/.creview" ] && [ ! -s "$TEST_LOG" ]; }

for hosts in pi omp 'pi omp'; do
    fresh
    case "$hosts" in
        pi) run success 1 '' ;;
        omp) run success 2 '' ;;
        'pi omp') run success 2 1 '' ;;
    esac
    printf 'git\tclone\t--branch\tmain\t%s\t%s\n' "$GIT_ORIGIN" "$HOME/.creview" > "$root/expected"
    for host in $hosts; do
        printf '%s\tinstall\t%s\n' "$host" "$HOME/.creview" >> "$root/expected"
        contains "Registered creview with $host."
    done
    diff "$root/expected" "$TEST_LOG"
    contains '/creview-config'
done

fresh
run failure ''
contains 'No hosts selected; nothing changed.'
no_write

fresh
run failure 1 2 1 2 ''
contains 'Install creview for:'
contains 'Type 1 or 2 to toggle; press Enter on an empty line to install:'
contains 'No hosts selected; nothing changed.'
no_write
tr -d '\r' < "$root/output" | grep '^  \[' > "$root/checklist"
diff - "$root/checklist" <<'CHECKLIST'
  [ ] 1) pi
  [ ] 2) omp
  [x] 1) pi
  [ ] 2) omp
  [x] 1) pi
  [x] 2) omp
  [ ] 1) pi
  [x] 2) omp
  [ ] 1) pi
  [ ] 2) omp
CHECKLIST

fresh
run failure invalid
contains 'Invalid selection; nothing changed.'
no_write

fresh
run failure 1 3 ''
contains 'Invalid selection; nothing changed.'
no_write

for dependency in git pi omp; do
    fresh
    mv "$bin/$dependency" "$root/missing"
    run failure 1 2 ''
    mv "$root/missing" "$bin/$dependency"
    contains 'is required'
    no_write
done

existing() {
    fresh
    mkdir "$HOME/.creview" "$TEST_GIT_STATE"
    printf '{"keep":"presets and reviewers"}\n' > "$root/data"
    cp "$root/data" "$HOME/.creview/creview.json"
    printf '%s\n' "$1" > "$TEST_GIT_STATE/head"
    printf '%s\n' published > "$TEST_GIT_STATE/prior"
}

checkout_state() {
    [ "$(cat "$TEST_GIT_STATE/head")" = "$1" ]
    [ "$(cat "$TEST_GIT_STATE/prior")" = "$2" ]
    diff "$root/data" "$HOME/.creview/creview.json"
}

registrations() {
    : > "$root/expected"
    for host do
        printf '%s\tinstall\t%s\n' "$host" "$HOME/.creview" >> "$root/expected"
        contains "Registered creview with $host."
    done
    awk -F '\t' '$1 == "pi" || $1 == "omp"' "$TEST_LOG" > "$root/registrations"
    diff "$root/expected" "$root/registrations"
}

existing published
run success 1 2 ''
contains 'creview is already up to date in'
checkout_state published published
registrations pi omp

for update in advance rewrite upstream-includes-local; do
    case "$update" in
        advance) existing published; GIT_TARGET=updated ;;
        rewrite) existing published; GIT_TARGET=rewritten; GIT_ANCESTOR_STATUS=1 ;;
        upstream-includes-local) existing local; GIT_TARGET=updated ;;
    esac
    run success 2 ''
    contains 'Updated creview in'
    checkout_state "$GIT_TARGET" "$GIT_TARGET"
    registrations omp
done

for rejection in diverged dirty wrong-branch detached status ancestry fetch checkout update-ref; do
    starting_head=published
    case "$rejection" in
        diverged|ancestry) starting_head=local ;;
    esac
    existing "$starting_head"
    GIT_TARGET=rewritten
    expected_head=$starting_head
    case "$rejection" in
        diverged) GIT_ANCESTOR_STATUS=1; message='has local commits' ;;
        dirty) GIT_CHANGES=' M tracked-file'; message='has tracked changes' ;;
        wrong-branch) GIT_BRANCH=refs/heads/other; message='must be checked out on branch main' ;;
        detached) GIT_BRANCH=''; message='must be checked out on branch main' ;;
        status) GIT_FAIL=status; message='Could not check for tracked changes' ;;
        ancestry) GIT_ANCESTOR_STATUS=17; message='Could not check main ancestry' ;;
        fetch) GIT_FAIL=fetch; message='Git fetch failed' ;;
        checkout) GIT_FAIL=checkout; message='Git checkout failed' ;;
        update-ref) GIT_FAIL=update-ref; expected_head=$GIT_TARGET; message='Could not update origin/main' ;;
    esac
    run failure 1 2 ''
    contains "$message"
    checkout_state "$expected_head" published
    registrations
    case "$rejection" in
        dirty|wrong-branch|detached|status|fetch) [ ! -e "$TEST_GIT_STATE/fetched" ] ;;
    esac
done

for missing in head prior; do
    existing published
    rm "$TEST_GIT_STATE/$missing"
    run failure 1 ''
    case "$missing" in
        head) contains 'Could not read HEAD' ;;
        prior) contains 'Could not read origin/main' ;;
    esac
    [ ! -e "$TEST_GIT_STATE/fetched" ]
    diff "$root/data" "$HOME/.creview/creview.json"
    registrations
done

for rejection in foreign nested root origin; do
    fresh
    mkdir "$HOME/.creview"
    printf 'untouched\n' > "$HOME/.creview/creview.json"
    case "$rejection" in
        foreign) GIT_ORIGIN='https://github.com/another/repo.git' ;;
        nested) GIT_PREFIX='nested/' ;;
        *) GIT_FAIL="$rejection" ;;
    esac
    run failure 1 2 ''
    [ "$(cat "$HOME/.creview/creview.json")" = untouched ]
    ! grep -q 'install' "$TEST_LOG"
done

fresh
: > "$HOME/.creview"
run failure 1 ''
contains 'already exists'
[ ! -s "$TEST_LOG" ]

fresh
GIT_FAIL=clone
run failure 1 2 ''
contains 'Git clone failed'
! grep -q 'install' "$TEST_LOG"

for host in pi omp; do
    fresh
    FAIL_HOST="$host"
    run failure 1 2 ''
    contains "$host registration failed"
    ! grep -q "Registered creview with $host" "$root/output"
    if [ "$host" = pi ]; then ! grep -q '^omp' "$TEST_LOG"; fi
done

fresh
if PATH="$bin" "$setsid_command" -w /bin/sh -c '/bin/cat "$INSTALLER" | /bin/sh' > "$root/output" 2>&1; then
    cat "$root/output"
    exit 1
fi
contains 'A terminal is required'
no_write
printf 'install.sh: pipeline/PTY checklist, spaced paths, safe updates, dependency/clone/registration errors and foreign destinations passed (%s isolated cases).\n' "$n"
