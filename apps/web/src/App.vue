<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppShell from '@/components/layout/AppShell.vue';
import ConnectDialog from '@/components/model-access/ConnectDialog.vue';
</script>

<template>
  <AppShell />
  <RouterView />
  <!-- The one ConnectDialog: every Connect, Reconnect and Get a new code opens it through
       useProvidersStore().connect(origin, onFollowUp, context). -->
  <ConnectDialog />
</template>
